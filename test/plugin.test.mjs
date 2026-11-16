import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPAT_BASE,
  asText,
  createBridge,
  flattenMessages,
  isCompatModel,
  listModels,
  parseToolCalls,
  readFailure,
  readRecord,
  setCompatModels,
  toCompletion,
  toErrorBody,
  toolsPreamble,
} from '../lib/onemin.mjs';

// ---- fixtures ----------------------------------------------------------------
// The success and failure envelopes are the shapes 1min really answers with,
// copied from live responses: HTTP 200 either way, and resultObject is an
// array of strings on success, an object on failure.

const SUCCESS_DOC = {
  aiRecord: {
    uuid: '0cf3f43f-bab9-43ba-a67c-4edb6ab38ea0',
    model: 'us.anthropic.claude-fable-5-2',
    type: 'UNIFY_CHAT_WITH_AI',
    status: 'SUCCESS',
    metadata: {
      credit: 7709,
      promptToken: 7,
      outputToken: 9,
      totalToken: 256,
      finishReason: 'stop',
      reasoningContent: '',
      executionTime: 2.904,
    },
    aiRecordDetail: {
      promptObject: { prompt: 'Reply with exactly: FABLE_OK' },
      resultObject: ['FABLE_OK'],
    },
  },
};

const FAILURE_DOC = {
  aiRecord: {
    uuid: '175032ea-0c7c-4512-8723-bd069345dc35',
    model: 'us.anthropic.claude-fable-5-2',
    status: 'FAILURE',
    metadata: { credit: 0 },
    aiRecordDetail: {
      promptObject: { prompt: 'ok' },
      resultObject: {
        code: 'INSUFFICIENT_CREDITS',
        name: 'InsufficientCreditsError',
        context:
          '{"reason":"TEAM_CREDIT_EXHAUSTED","requiredCredit":4910,"availableCredit":0,"plan":"FREE"}',
        message:
          "The feature requires 4910 credits, but the Team team only has 0 credits. Upgrade your plan or buy a credit top-up to continue.",
        errorSeverity: 'low',
      },
    },
  },
};

const CATALOG_DOC = {
  models: [
    {
      modelId: 'us.anthropic.claude-fable-5-2',
      name: 'Claude 5.2 Fable - AWS Bedrock US',
      status: 'ACTIVE',
      creditMetadata: { CONTEXT: 1000000, MAX_OUTPUT_TOKEN: 128000, INPUT: 8.8, OUTPUT: 44 },
      modality: { INPUT: ['text', 'image'], OUTPUT: ['text'] },
    },
    { modelId: 'NOT_APPLICABLE', name: 'NOT_APPLICABLE', status: 'ACTIVE' },
    { modelId: 'gone-model', name: 'Gone', status: 'INACTIVE' },
  ],
};

const COMPAT_DOC = {
  object: 'list',
  data: [
    { id: 'gpt-4.1-mini', object: 'model', owned_by: 'openai', context_length: 1047576, max_completion_tokens: 32768 },
  ],
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events) {
  const body = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A fetch double that records the calls and answers with the given replies. */
function stubFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}

// ---- reading requests --------------------------------------------------------

test('a lone user message is passed through without role tags', () => {
  assert.equal(flattenMessages([{ role: 'user', content: 'hello' }]), 'hello');
});

test('a conversation becomes a role-tagged transcript', () => {
  const prompt = flattenMessages([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ]);
  assert.equal(prompt, '[System]\nbe brief\n\n[User]\nhi\n\n[Assistant]\nhello\n\n[User]\nagain');
});

test('content parts are flattened, images marked as omitted', () => {
  assert.equal(
    asText([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:…' } },
    ]),
    'look\n[image omitted]',
  );
});

test('empty messages are dropped and an empty list gives an empty prompt', () => {
  assert.equal(flattenMessages([]), '');
  assert.equal(flattenMessages([{ role: 'user', content: '   ' }]), '');
});

// ---- tool emulation ----------------------------------------------------------

test('tools are described in the prompt', () => {
  const preamble = toolsPreamble([
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ]);
  assert.match(preamble, /- get_weather: weather for a city/);
  assert.match(preamble, /"city":\{"type":"string"\}/);
  assert.match(preamble, /tool_calls/);
});

test('no tools, no preamble', () => {
  assert.equal(toolsPreamble([]), '');
  assert.equal(toolsPreamble(undefined), '');
});

test('a fenced tool call is read back', () => {
  const calls = parseToolCalls('```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}\n```');
  assert.deepEqual(calls, [{ name: 'get_weather', arguments: { city: 'Paris' } }]);
});

test('a bare tool call is read back too', () => {
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"name":"ping","arguments":{}}]}'), [
    { name: 'ping', arguments: {} },
  ]);
});

test('prose and malformed blocks are not tool calls', () => {
  assert.equal(parseToolCalls('The weather in Paris is mild.'), null);
  assert.equal(parseToolCalls('```json\nnot json\n```'), null);
  assert.equal(parseToolCalls('{"tool_calls":[]}'), null);
  assert.equal(parseToolCalls(''), null);
});

test('arguments given as a JSON string are parsed', () => {
  assert.deepEqual(
    parseToolCalls('{"tool_calls":[{"name":"t","arguments":"{\\"a\\":1}"}]}'),
    [{ name: 't', arguments: { a: 1 } }],
  );
});

// ---- reading replies ---------------------------------------------------------

test('a success record is read into text, reasoning and usage', () => {
  const { text, usage } = readRecord(SUCCESS_DOC.aiRecord);
  assert.equal(text, 'FABLE_OK');
  assert.deepEqual(usage, { prompt_tokens: 7, completion_tokens: 9, total_tokens: 256 });
});

test('reasoning content is read when present', () => {
  const doc = {
    aiRecord: {
      status: 'SUCCESS',
      metadata: { reasoningContent: 'thinking…', promptToken: 1, outputToken: 2, totalToken: 3 },
      aiRecordDetail: { resultObject: ['done'] },
    },
  };
  assert.equal(readRecord(doc.aiRecord).reasoning, 'thinking…');
});

test('a success record reports no failure', () => {
  assert.equal(readFailure(SUCCESS_DOC), null);
});

test('a failure record is read out of its object-shaped resultObject', () => {
  const failure = readFailure(FAILURE_DOC);
  assert.equal(failure.code, 'INSUFFICIENT_CREDITS');
  assert.match(failure.message, /only has 0 credits/);
});

test('a failure with a bare string result is still read', () => {
  const failure = readFailure({ aiRecord: { status: 'FAILURE', aiRecordDetail: { resultObject: 'boom' } } });
  assert.deepEqual(failure, { code: 'UPSTREAM_ERROR', message: 'boom' });
});

test('a failure with nothing readable still says something', () => {
  const failure = readFailure({ aiRecord: { status: 'FAILURE' } });
  assert.equal(failure.code, 'UPSTREAM_ERROR');
  assert.ok(failure.message.length > 0);
});

test('a non-envelope reply reports no failure and no text', () => {
  assert.equal(readFailure({}), null);
  assert.equal(readRecord(undefined).text, '');
});

test('insufficient credits becomes a 429, anything else a 502', () => {
  assert.equal(toErrorBody({ code: 'INSUFFICIENT_CREDITS', message: 'x' }).status, 429);
  assert.equal(toErrorBody({ code: 'UPSTREAM_ERROR', message: 'x' }).status, 502);
});

// ---- completion shape --------------------------------------------------------

test('a text completion is OpenAI-shaped', () => {
  const reply = toCompletion({
    id: 'chatcmpl-1',
    model: 'm',
    created: 1,
    text: 'hi',
    reasoning: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  assert.equal(reply.object, 'chat.completion');
  assert.equal(reply.choices[0].message.content, 'hi');
  assert.equal(reply.choices[0].finish_reason, 'stop');
});

test('a tool call completion carries tool_calls and no content', () => {
  const reply = toCompletion({
    id: 'c',
    model: 'm',
    created: 1,
    text: 'ignored',
    usage: {},
    calls: [{ name: 't', arguments: { a: 1 } }],
  });
  const message = reply.choices[0].message;
  assert.equal(message.content, null);
  assert.equal(message.tool_calls[0].function.name, 't');
  assert.equal(message.tool_calls[0].function.arguments, '{"a":1}');
  assert.equal(reply.choices[0].finish_reason, 'tool_calls');
});

// ---- the bridge --------------------------------------------------------------

test('a non-streamed reply is translated to a completion', async () => {
  setCompatModels([]);
  const fake = stubFetch([jsonResponse(SUCCESS_DOC)]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });

  const res = await bridge('https://api.1min.ai/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'us.anthropic.claude-fable-5-2',
      messages: [{ role: 'user', content: 'Reply with exactly: FABLE_OK' }],
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'FABLE_OK');
  assert.equal(body.usage.prompt_tokens, 7);

  const sent = JSON.parse(fake.calls[0].init.body);
  assert.equal(fake.calls[0].url, 'https://api.1min.ai/api/chat-with-ai');
  assert.equal(sent.type, 'UNIFY_CHAT_WITH_AI');
  assert.equal(sent.model, 'us.anthropic.claude-fable-5-2');
  assert.equal(sent.promptObject.prompt, 'Reply with exactly: FABLE_OK');
  assert.equal(fake.calls[0].init.headers['api-key'], 'k');
});

test('a streamed reply becomes OpenAI chunks', async () => {
  setCompatModels([]);
  const fake = stubFetch([
    sseResponse([
      ['reasoning', { content: 'thinking' }],
      ['content', { content: 'FA' }],
      ['content', { content: 'BLE_OK' }],
      ['result', SUCCESS_DOC],
      ['done', { message: 'Stream completed' }],
    ]),
  ]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });

  const res = await bridge('https://api.1min.ai/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'us.anthropic.claude-fable-5-2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
  });

  assert.equal(res.status, 200);
  const text = await res.text();
  const chunks = text
    .split('\n\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)));

  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(
    chunks.map((c) => c.choices[0].delta.content ?? '').join(''),
    'FABLE_OK',
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(chunks.at(-1).usage.completion_tokens, 9);
  assert.match(text, /data: \[DONE\]/);
  assert.match(fake.calls[0].url, /isStreaming=true/);
});

test('a stream that carries no content still delivers the whole reply', async () => {
  setCompatModels([]);
  const doc = {
    aiRecord: {
      status: 'SUCCESS',
      metadata: { promptToken: 1, outputToken: 2, totalToken: 3 },
      aiRecordDetail: { resultObject: ['only at the end'] },
    },
  };
  const fake = stubFetch([sseResponse([['result', doc], ['done', {}]])]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });

  const res = await bridge('https://x/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }),
  });
  const text = await res.text();
  assert.match(text, /only at the end/);
});

test('a failed stream reports the error then ends', async () => {
  setCompatModels([]);
  const fake = stubFetch([sseResponse([['result', FAILURE_DOC], ['done', {}]])]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });

  const res = await bridge('https://x/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }),
  });
  const text = await res.text();
  assert.match(text, /INSUFFICIENT_CREDITS/);
  assert.match(text, /data: \[DONE\]/);
});

test('a failed request answers the OpenAI error body', async () => {
  setCompatModels([]);
  const fake = stubFetch([jsonResponse(FAILURE_DOC)]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });

  const res = await bridge('https://x/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.code, 'INSUFFICIENT_CREDITS');
  assert.equal(body.error.type, 'insufficient_quota');
});

test('tools turn a reply into tool_calls', async () => {
  setCompatModels([]);
  const doc = {
    aiRecord: {
      status: 'SUCCESS',
      metadata: { promptToken: 1, outputToken: 2, totalToken: 3 },
      aiRecordDetail: {
        resultObject: ['```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}\n```'],
      },
    },
  };
  const fake = stubFetch([jsonResponse(doc)]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });

  const res = await bridge('https://x/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    }),
  });
  const body = await res.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
  // the tool was described in the prompt the vendor got
  assert.match(JSON.parse(fake.calls[0].init.body).promptObject.prompt, /get_weather/);
});

test('with tools offered, streaming waits for the whole reply', async () => {
  setCompatModels([]);
  const fake = stubFetch([jsonResponse(SUCCESS_DOC)]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });

  const res = await bridge('https://x/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 't' } }],
      stream: true,
    }),
  });
  assert.equal(fake.calls[0].url, 'https://api.1min.ai/api/chat-with-ai');
  const text = await res.text();
  assert.match(text, /FABLE_OK/);
  assert.match(text, /\[DONE\]/);
});

test('a model /openai/v1 serves goes there untouched', async () => {
  setCompatModels(['gpt-4.1-mini']);
  const fake = stubFetch([jsonResponse({ choices: [{ message: { content: 'native' } }] })]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });

  const res = await bridge('https://api.1min.ai/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'x' }] }),
  });

  assert.equal(fake.calls[0].url, 'https://api.1min.ai/openai/v1/chat/completions');
  assert.equal(fake.calls[0].init.headers.authorization, 'Bearer k');
  assert.equal((await res.json()).choices[0].message.content, 'native');
});

test('a request with no model is refused without asking the vendor', async () => {
  setCompatModels([]);
  const fake = stubFetch([]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });
  const res = await bridge('https://x/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 400);
  assert.equal(fake.calls.length, 0);
});

test('a network failure is reported as a 502', async () => {
  setCompatModels([]);
  const fake = stubFetch([
    () => {
      throw new Error('ECONNREFUSED');
    },
  ]);
  const bridge = createBridge({ apiKey: 'k', fetchImpl: fake });
  const res = await bridge('https://x/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /ECONNREFUSED/);
});

// ---- the catalogs ------------------------------------------------------------

test('the catalog reads both lanes and marks which is which', async () => {
  setCompatModels([]);
  const fake = stubFetch([jsonResponse(CATALOG_DOC), jsonResponse(COMPAT_DOC)]);
  const models = await listModels({ apiKey: 'k', fetchImpl: fake });

  assert.ok(models['us.anthropic.claude-fable-5-2']);
  assert.equal(models['us.anthropic.claude-fable-5-2'].limit.context, 1000000);
  assert.equal(models['us.anthropic.claude-fable-5-2'].status, 'active');
  // NOT_APPLICABLE and INACTIVE are not models
  assert.equal(models.NOT_APPLICABLE, undefined);
  assert.equal(models['gone-model'], undefined);
  // the compatible lane is listed and remembered
  assert.ok(models['gpt-4.1-mini']);
  assert.equal(isCompatModel('gpt-4.1-mini'), true);
  assert.equal(isCompatModel('us.anthropic.claude-fable-5-2'), false);
});

test('one lane failing still lists the other', async () => {
  setCompatModels([]);
  const fake = stubFetch([
    jsonResponse(CATALOG_DOC),
    () => {
      throw new Error('compat down');
    },
  ]);
  const models = await listModels({ apiKey: 'k', fetchImpl: fake });
  assert.ok(models['us.anthropic.claude-fable-5-2']);
});

// The vendor has answered /openai/v1 with 200 and `data: []` under load. That
// is a failed read, not a catalog with nothing in it: taking it at face value
// would empty the picker and send a model /openai/v1 serves down the bridge.
test('an empty compatible catalog is a failure, not a catalog', async () => {
  setCompatModels(['gpt-4.1-mini']);
  const fake = stubFetch([jsonResponse(CATALOG_DOC), jsonResponse({ object: 'list', data: [] })]);
  const models = await listModels({ apiKey: 'k', fetchImpl: fake });
  assert.ok(models['us.anthropic.claude-fable-5-2']);
  assert.equal(models['gpt-4.1-mini'], undefined);
  // what was known stays known
  assert.equal(isCompatModel('gpt-4.1-mini'), true);
});

test('an empty bridged catalog is a failure too', async () => {
  setCompatModels([]);
  const fake = stubFetch([jsonResponse({ models: [] }), jsonResponse(COMPAT_DOC)]);
  const models = await listModels({ apiKey: 'k', fetchImpl: fake });
  assert.ok(models['gpt-4.1-mini']);
});

test('both lanes failing throws, so the caller keeps what it had', async () => {
  setCompatModels([]);
  const fake = stubFetch([
    () => {
      throw new Error('a');
    },
    () => {
      throw new Error('b');
    },
  ]);
  await assert.rejects(() => listModels({ apiKey: 'k', fetchImpl: fake }), /no model list/);
});

test('a rejected key marks the sign-in expired', async () => {
  setCompatModels([]);
  const fake = stubFetch([
    () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    },
    () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    },
  ]);
  await assert.rejects(() => listModels({ apiKey: 'k', fetchImpl: fake }), (error) => {
    assert.equal(error.signIn, 'expired');
    return true;
  });
});

test('the catalog is asked at the two documented URLs', async () => {
  setCompatModels([]);
  const fake = stubFetch([jsonResponse(CATALOG_DOC), jsonResponse(COMPAT_DOC)]);
  await listModels({ apiKey: 'k', fetchImpl: fake });
  const urls = fake.calls.map((call) => call.url).sort();
  assert.deepEqual(urls, [
    'https://api.1min.ai/models?feature=UNIFY_CHAT_WITH_AI',
    'https://api.1min.ai/openai/v1/models',
  ]);
});

// ---- the plugin --------------------------------------------------------------

test('the plugin signs in with a key and bridges it', async () => {
  const { default: plugin } = await import('../index.mjs');
  const hooks = await plugin({});

  // config seeds the provider
  const config = {};
  await hooks.config(config);
  assert.equal(config.provider.onemin.name, '1min.AI');
  assert.equal(config.provider.onemin.options.baseURL, COMPAT_BASE);

  // an empty key is refused
  const method = hooks.auth.methods[0];
  assert.equal((await method.authorize({ apiKey: '  ' })).type, 'failed');
  assert.equal((await method.authorize({ apiKey: '  sk-1  ' })).key, 'sk-1');

  // the loader hands over a fetch the bridge built
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'sk-1' }), {
    options: { baseURL: COMPAT_BASE },
  });
  assert.equal(loader.apiKey, 'sk-1');
  assert.equal(typeof loader.fetch, 'function');
});

test('the loader refuses a missing key', async () => {
  const { default: plugin } = await import('../index.mjs');
  const hooks = await plugin({});
  await assert.rejects(() => hooks.auth.loader(async () => ({ type: 'api', key: '' }), {}));
});

test('the model hook keeps what it had when the listing fails', async () => {
  const { default: plugin } = await import('../index.mjs');
  const hooks = await plugin({});
  const existing = { m: { id: 'm' } };
  const models = await hooks.provider.models({ models: existing }, { auth: { key: '' } });
  assert.deepEqual(models, existing);
});

test('the icon is a data URL', async () => {
  const { default: plugin } = await import('../index.mjs');
  const hooks = await plugin({});
  assert.match(hooks.auth.icon, /^data:image\/svg\+xml;base64,/);
});
