// 1min.AI bridge for magpie.
//
// 1min.AI serves its Claude Fable models (5 / 5.1 / 5.2) only on
// POST /api/chat-with-ai, with a request and reply shape of its own:
//
//   → { type: 'UNIFY_CHAT_WITH_AI', model, promptObject: { prompt } }
//   ← { aiRecord: { status, metadata, aiRecordDetail: { resultObject: [ … ] } } }
//
// Two shapes bite a caller that does not bridge them:
//   • failures answer HTTP 200, with status FAILURE and resultObject an
//     object where a success has an array of strings;
//   • streaming is SSE with its own events (reasoning, content, result, done),
//     not OpenAI's deltas.
//
// Its /openai/v1 endpoint, by contrast, is genuinely OpenAI-shaped — but it
// serves a different catalog with no Fable in it. So this plugin runs two
// lanes: models only /openai/v1 lists go there untouched (real streaming,
// real tool calls), everything else is bridged onto chat-with-ai.

export const PROVIDER_ID = 'onemin';

export const BRIDGE_URL = 'https://api.1min.ai/api/chat-with-ai';
export const MODELS_URL = 'https://api.1min.ai/models?feature=UNIFY_CHAT_WITH_AI';
export const COMPAT_BASE = 'https://api.1min.ai/openai/v1';
export const COMPAT_MODELS_URL = `${COMPAT_BASE}/models`;

const UA = 'magpie-plugin-onemin/0.1.0';
const REQUEST_TIMEOUT_MS = 120_000;

/** Model ids that /openai/v1 serves itself; everything else takes the bridge. */
const compatModels = new Set();

export function setCompatModels(ids) {
  compatModels.clear();
  for (const id of ids ?? []) if (typeof id === 'string' && id) compatModels.add(id);
}

export function isCompatModel(model) {
  return typeof model === 'string' && compatModels.has(model);
}

// ---- reading a request -------------------------------------------------------

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The text of a message's content, whether a string or a list of parts. */
export function asText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (record(part) && typeof part.text === 'string') parts.push(part.text);
      else if (record(part) && part.type === 'image_url') parts.push('[image omitted]');
    }
    return parts.join('\n');
  }
  if (record(content) && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * chat-with-ai takes a single prompt string, so a conversation becomes a
 * role-tagged transcript. A lone user message is passed through as written.
 */
export function flattenMessages(messages) {
  const parts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!record(message)) continue;
    const role = String(message.role ?? 'user').toLowerCase();
    const text = asText(message.content);
    if (!text.trim()) continue;
    if (role === 'system') parts.push(`[System]\n${text}`);
    else if (role === 'assistant') parts.push(`[Assistant]\n${text}`);
    else if (role === 'tool') parts.push(`[Tool result]\n${text}`);
    else parts.push(`[User]\n${text}`);
  }
  if (parts.length === 0) return '';
  if (parts.length === 1 && parts[0].startsWith('[User]\n')) return parts[0].slice(7);
  return parts.join('\n\n');
}

/**
 * chat-with-ai has no tool protocol, so tools are emulated in the prompt: the
 * model is asked for a fenced JSON block, and parseToolCalls reads it back.
 */
export function toolsPreamble(tools) {
  const lines = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const fn = record(tool) ? tool.function ?? tool : null;
    if (!record(fn) || typeof fn.name !== 'string' || !fn.name) continue;
    const description = typeof fn.description === 'string' ? fn.description : '';
    let parameters = '{}';
    try {
      parameters = JSON.stringify(fn.parameters ?? {});
    } catch {
      parameters = '{}';
    }
    lines.push(`- ${fn.name}: ${description}\n  parameters: ${parameters}`);
  }
  if (lines.length === 0) return '';
  return [
    'You can call the tools listed below. To call one, reply with only this block:',
    '```json',
    '{"tool_calls":[{"name":"TOOL_NAME","arguments":{}}]}',
    '```',
    'Put no other text in a reply that calls a tool. Answer normally when none is needed.',
    '',
    'Tools:',
    ...lines,
  ].join('\n');
}

/** The tool calls a reply asked for, or null when it asked for none. */
export function parseToolCalls(text) {
  if (typeof text !== 'string' || !text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let doc;
  try {
    doc = JSON.parse(fenced ? fenced[1] : text.trim());
  } catch {
    return null;
  }
  const calls = record(doc) ? doc.tool_calls : null;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const out = [];
  for (const call of calls) {
    if (!record(call)) return null;
    const fn = record(call.function) ? call.function : call;
    if (typeof fn.name !== 'string' || !fn.name) return null;
    let args = fn.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    if (!record(args)) return null;
    out.push({ name: fn.name, arguments: args });
  }
  return out;
}

// ---- reading a reply ---------------------------------------------------------

/**
 * chat-with-ai puts a failure in aiRecordDetail.resultObject — an object on
 * failure, an array of strings on success — and answers HTTP 200 either way.
 */
export function readFailure(doc) {
  const aiRecord = record(doc) ? doc.aiRecord : null;
  if (!record(aiRecord)) return null;
  if (aiRecord.status === 'SUCCESS') return null;
  const result = record(aiRecord.aiRecordDetail) ? aiRecord.aiRecordDetail.resultObject : null;
  if (record(result) && typeof result.code === 'string') {
    return { code: result.code, message: typeof result.message === 'string' ? result.message : result.code };
  }
  if (typeof result === 'string' && result) return { code: 'UPSTREAM_ERROR', message: result };
  return { code: 'UPSTREAM_ERROR', message: `1min answered ${aiRecord.status ?? 'FAILURE'} with no detail` };
}

/** The reply text and reasoning a finished aiRecord carries. */
export function readRecord(aiRecord) {
  const detail = record(aiRecord?.aiRecordDetail) ? aiRecord.aiRecordDetail : {};
  const result = detail.resultObject;
  let text = '';
  if (Array.isArray(result)) {
    text = result.filter((part) => typeof part === 'string').join('');
  } else if (typeof result === 'string') {
    text = result;
  }
  const metadata = record(aiRecord?.metadata) ? aiRecord.metadata : {};
  const reasoning = typeof metadata.reasoningContent === 'string' ? metadata.reasoningContent : '';
  const usage = {
    prompt_tokens: Number.isFinite(metadata.promptToken) ? metadata.promptToken : 0,
    completion_tokens: Number.isFinite(metadata.outputToken) ? metadata.outputToken : 0,
    total_tokens: Number.isFinite(metadata.totalToken) ? metadata.totalToken : 0,
  };
  return { text, reasoning, usage };
}

// ---- writing a reply ---------------------------------------------------------

function newId(prefix) {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toolCallPayload(calls) {
  return calls.map((call) => ({
    id: newId('call_'),
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
}

export function toCompletion({ id, model, created, text, reasoning, usage, calls }) {
  const message = { role: 'assistant', content: calls ? null : text };
  if (calls) message.tool_calls = toolCallPayload(calls);
  else if (reasoning) message.reasoning_content = reasoning;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: calls ? 'tool_calls' : 'stop' }],
    usage,
  };
}

/** The OpenAI error body a bridged failure becomes. */
export function toErrorBody(failure) {
  const status = failure.code === 'INSUFFICIENT_CREDITS' ? 429 : 502;
  return {
    status,
    body: {
      error: {
        message: failure.message,
        type: failure.code === 'INSUFFICIENT_CREDITS' ? 'insufficient_quota' : 'upstream_error',
        code: failure.code,
      },
    },
  };
}

function sseChunk(id, model, created, delta, finishReason = null, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ---- streaming ---------------------------------------------------------------

async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line === '') {
        event = null;
        continue;
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = { raw };
        }
        yield { event, data };
      }
    }
  }
}

function textStream(body) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

/** The bridged stream: 1min's events rewritten as OpenAI chunks. */
function bridgeStream(upstream, { model, toolEmulation }) {
  const id = newId('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text) => controller.enqueue(encoder.encode(text));
      let sawText = false;
      let failure = null;
      try {
        send(sseChunk(id, model, created, { role: 'assistant' }));
        for await (const { event, data } of sseEvents(upstream.body)) {
          if (event === 'content') {
            const piece = typeof data.content === 'string' ? data.content : '';
            if (piece) {
              sawText = true;
              send(sseChunk(id, model, created, { content: piece }));
            }
          } else if (event === 'reasoning') {
            const piece = typeof data.content === 'string' ? data.content : '';
            if (piece) send(sseChunk(id, model, created, { reasoning_content: piece }));
          } else if (event === 'result') {
            failure = readFailure(data);
            if (failure) break;
            const { text, usage, reasoning } = readRecord(data.aiRecord);
            // a reply that streamed no content (a tool call, an empty turn)
            // still has to reach the client
            if (!sawText && text) send(sseChunk(id, model, created, { content: text }));
            else if (!sawText && reasoning) send(sseChunk(id, model, created, { content: reasoning }));
            send(sseChunk(id, model, created, {}, 'stop', usage));
          } else if (event === 'error') {
            failure = { code: 'UPSTREAM_ERROR', message: JSON.stringify(data) };
            break;
          }
        }
        if (failure) {
          const { body } = toErrorBody(failure);
          send(`data: ${JSON.stringify(body)}\n\n`);
        }
        send('data: [DONE]\n\n');
      } catch (error) {
        const { body } = toErrorBody({ code: 'UPSTREAM_ERROR', message: String(error?.message ?? error) });
        try {
          send(`data: ${JSON.stringify(body)}\n\n`);
          send('data: [DONE]\n\n');
        } catch {
          // the client went away
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return textStream(stream);
}

/** A whole reply, as one stream, for a client that asked to stream. */
function wholeReplyStream(reply, model) {
  const id = newId('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const message = reply.choices[0].message;
  const stream = new ReadableStream({
    start(controller) {
      const send = (text) => controller.enqueue(encoder.encode(text));
      send(sseChunk(id, model, created, { role: 'assistant' }));
      if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
        send(sseChunk(id, model, created, { reasoning_content: message.reasoning_content }));
      }
      if (Array.isArray(message.tool_calls)) {
        send(sseChunk(id, model, created, { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }));
        send(sseChunk(id, model, created, {}, 'tool_calls', reply.usage));
      } else {
        if (message.content) send(sseChunk(id, model, created, { content: message.content }));
        send(sseChunk(id, model, created, {}, 'stop', reply.usage));
      }
      send('data: [DONE]\n\n');
      controller.close();
    },
  });
  return textStream(stream);
}

// ---- the bridge itself -------------------------------------------------------

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readJsonBody(body) {
  if (typeof body !== 'string') return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * The fetch the provider runs on: /openai/v1 requests go as they came, and
 * everything else is rewritten onto chat-with-ai and translated back.
 */
export function createBridge({ apiKey, fetchImpl = globalThis.fetch, toolEmulation = true } = {}) {
  const deadline = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  return async function bridgeFetch(url, init = {}) {
    const signal = init.signal ? AbortSignal.any([init.signal, deadline()]) : deadline();
    const request = readJsonBody(init.body);

    // a request the SDK built for a model /openai/v1 serves: as it came,
    // with its own streaming and tool calls
    if (request && isCompatModel(request.model)) {
      return fetchImpl(url, { ...init, headers: withAuth(init.headers, apiKey), signal });
    }

    if (!request) {
      return jsonResponse(
        { error: { message: 'onemin: the request body is not JSON', type: 'invalid_request_error' } },
        400,
      );
    }

    const model = typeof request.model === 'string' ? request.model : '';
    if (!model) {
      return jsonResponse({ error: { message: 'onemin: no model in the request', type: 'invalid_request_error' } }, 400);
    }

    const wantsStream = request.stream === true;
    const tools = toolEmulation ? request.tools : null;
    const preamble = toolsPreamble(tools);
    const prompt = [preamble, flattenMessages(request.messages)].filter(Boolean).join('\n\n');

    // A tool call is read out of the finished text, so a request that offers
    // tools can't stream its content as it arrives: it waits for the whole
    // reply, then hands it over as a stream of its own.
    const streamUpstream = wantsStream && !(tools && preamble);

    const upstreamBody = {
      type: 'UNIFY_CHAT_WITH_AI',
      model,
      promptObject: { prompt },
    };

    let upstream;
    try {
      upstream = await fetchImpl(BRIDGE_URL + (streamUpstream ? '?isStreaming=true' : ''), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': apiKey,
          accept: streamUpstream ? 'text/event-stream' : 'application/json',
          'user-agent': UA,
        },
        body: JSON.stringify(upstreamBody),
        signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      return jsonResponse(
        { error: { message: `onemin: ${String(error?.message ?? error)}`, type: 'upstream_error' } },
        502,
      );
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return jsonResponse(
        {
          error: {
            message: `onemin: HTTP ${upstream.status} ${text.slice(0, 400)}`.trim(),
            type: 'upstream_error',
          },
        },
        upstream.status === 401 ? 401 : 502,
      );
    }

    const contentType = upstream.headers.get('content-type') ?? '';

    if (streamUpstream && contentType.includes('text/event-stream')) {
      return bridgeStream(upstream, { model, toolEmulation });
    }

    let doc;
    try {
      doc = await upstream.json();
    } catch (error) {
      return jsonResponse(
        { error: { message: `onemin: the reply was not JSON (${String(error?.message ?? error)})`, type: 'upstream_error' } },
        502,
      );
    }

    const failure = readFailure(doc);
    if (failure) {
      const { status, body } = toErrorBody(failure);
      return jsonResponse(body, status);
    }

    const { text, reasoning, usage } = readRecord(doc?.aiRecord);
    const calls = toolEmulation ? parseToolCalls(text) : null;
    const reply = toCompletion({
      id: newId('chatcmpl-'),
      model,
      created: Math.floor(Date.now() / 1000),
      text,
      reasoning,
      usage,
      calls,
    });
    return wantsStream ? wholeReplyStream(reply, model) : jsonResponse(reply);
  };
}

function withAuth(headers, apiKey) {
  const out = {};
  const source = headers instanceof Headers ? headers : new Headers(headers ?? {});
  let had = false;
  source.forEach((value, key) => {
    if (key.toLowerCase() === 'authorization') had = true;
    out[key] = value;
  });
  if (!had && apiKey) out.authorization = `Bearer ${apiKey}`;
  return out;
}

// ---- the catalogs ------------------------------------------------------------

const CAPABILITY_KEYS = new Set(['reasoning', 'toolcall', 'attachment']);

function modelEntry(item, toolEmulation) {
  const credit = record(item.creditMetadata) ? item.creditMetadata : {};
  const modality = record(item.modality) ? item.modality : {};
  const inputs = Array.isArray(modality.INPUT) ? modality.INPUT : ['text'];
  const context = Number.isFinite(credit.CONTEXT) ? credit.CONTEXT : 0;
  const output = Number.isFinite(credit.MAX_OUTPUT_TOKEN) ? credit.MAX_OUTPUT_TOKEN : 0;
  return {
    id: item.modelId,
    name: typeof item.name === 'string' && item.name ? item.name : item.modelId,
    api: { id: item.modelId, url: COMPAT_BASE, npm: '@ai-sdk/openai-compatible' },
    limit: { context, output },
    capabilities: {
      // chat-with-ai reports nothing certain of these: reasoning text comes
      // back in metadata, tool calls are the prompt emulation, images only
      // through 1min's own asset API
      reasoning: true,
      toolcall: toolEmulation,
      attachment: false,
      input: { text: true, image: inputs.includes('image') },
      output: { text: true },
    },
    status: item.status === 'ACTIVE' ? 'active' : undefined,
  };
}

function compatibleEntry(item, toolEmulation) {
  const context = Number.isFinite(item.context_length) ? item.context_length : 0;
  const output = Number.isFinite(item.max_completion_tokens) ? item.max_completion_tokens : 0;
  return {
    id: item.id,
    name: typeof item.display_name === 'string' && item.display_name ? item.display_name : item.id,
    api: { id: item.id, url: COMPAT_BASE, npm: '@ai-sdk/openai-compatible' },
    limit: { context, output },
    capabilities: {
      reasoning: true,
      toolcall: true,
      attachment: false,
      input: { text: true, image: true },
      output: { text: true },
    },
    status: 'active',
  };
}

async function getJson(url, apiKey, fetchImpl, signal) {
  const response = await fetchImpl(url, {
    headers: { 'api-key': apiKey, authorization: `Bearer ${apiKey}`, 'user-agent': UA, accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    const error = new Error(`1min answered HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * Every model the two catalogs serve: the bridged ones (Fable among them)
 * and the ones /openai/v1 answers itself.
 *
 * An empty list is treated as a failed fetch, not as a catalog with nothing
 * in it: the vendor has been seen to answer 200 with `data: []` under load,
 * and taking that at face value would empty the picker and send a model
 * /openai/v1 serves down the bridge.
 */
export async function listModels({ apiKey, fetchImpl = globalThis.fetch, toolEmulation = true, signal } = {}) {
  const timeout = AbortSignal.timeout(30_000);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const models = {};
  const failures = [];

  const readBridged = async () => {
    const doc = await getJson(MODELS_URL, apiKey, fetchImpl, both);
    const list = Array.isArray(doc?.models) ? doc.models : [];
    if (list.length === 0) throw new Error('the bridged catalog came back empty');
    return list;
  };

  const readCompatible = async () => {
    const doc = await getJson(COMPAT_MODELS_URL, apiKey, fetchImpl, both);
    const list = Array.isArray(doc?.data) ? doc.data : [];
    if (list.length === 0) throw new Error('the compatible catalog came back empty');
    return list;
  };

  const [bridged, compatible] = await Promise.allSettled([readBridged(), readCompatible()]);

  if (bridged.status === 'fulfilled') {
    for (const item of bridged.value) {
      if (!record(item) || item.status !== 'ACTIVE') continue;
      if (typeof item.modelId !== 'string' || !item.modelId || item.modelId === 'NOT_APPLICABLE') continue;
      models[item.modelId] = modelEntry(item, toolEmulation);
    }
  } else {
    failures.push(bridged.reason);
  }

  if (compatible.status === 'fulfilled') {
    const ids = [];
    for (const item of compatible.value) {
      if (!record(item) || typeof item.id !== 'string' || !item.id) continue;
      ids.push(item.id);
      if (!models[item.id]) models[item.id] = compatibleEntry(item, toolEmulation);
    }
    // only a catalog that actually answered replaces what was known
    if (ids.length > 0) setCompatModels(ids);
  } else {
    failures.push(compatible.reason);
  }

  if (Object.keys(models).length === 0 && failures.length > 0) {
    const first = failures[0];
    throw Object.assign(new Error(`onemin: no model list (${first?.message ?? first})`), {
      signIn: first?.status === 401 ? 'expired' : undefined,
    });
  }

  return models;
}

export { CAPABILITY_KEYS };
