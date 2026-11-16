# magpie-plugin-onemin

A [magpie](https://github.com/m0eak/magpie) provider for **1min.AI**.

It exists for one reason: the Claude **Fable** models (5 / 5.1 / 5.2) that 1min.AI serves
are on `POST /api/chat-with-ai` only. 1min's OpenAI-compatible endpoint `/openai/v1` is
real OpenAI — SDK-friendly, streaming, tool calls — but its catalog is a *different* one
and has no Fable in it. Point a client at `/openai/v1` and Fable is simply absent; point
it at `chat-with-ai` and nothing speaks its shape.

This plugin bridges that gap inside magpie: no sidecar, no proxy, no second port.

```bash
magpie plugin add github:xunnychen/magpie-plugin-onemin
magpie plugin login onemin          # paste your 1min.AI API key
magpie provider onemin              # every model it lists, both lanes
magpie claude onemin/us.anthropic.claude-fable-5-2
```

## What it does

Two lanes, chosen per model:

| Model | Goes to | Streaming | Tool calls |
|---|---|---|---|
| anything `/openai/v1` lists (`gpt-4.1-mini`, `qwen3.7-max`, …) | `/openai/v1/chat/completions`, untouched | native | native |
| everything else — Fable, Opus, Sonnet, Qwen3.8, … | `/api/chat-with-ai`, bridged | bridged | emulated in the prompt |

The bridge is a `fetch` the provider's `auth.loader` returns, so magpie (and every agent
behind it) sees an ordinary OpenAI-compatible provider.

### Two shapes that need bridging

1. **Failures answer HTTP 200.** A failed call is still `200 OK`, with
   `aiRecord.status = "FAILURE"` and `aiRecordDetail.resultObject` holding an *object*
   (`{code, message, …}`) where a success holds an *array of strings*. A client that only
   reads `.resultObject[]` sees an empty string and thinks the call worked. This plugin
   reads the failure out and turns it into a real `429` (`INSUFFICIENT_CREDITS`) or `502`.
2. **Streaming is its own SSE.** Events are `reasoning`, `content`, `result`, `done` —
   not `choices[].delta`. The plugin rewrites them into OpenAI chunks, including a
   `reasoning_content` delta for the reasoning lane.

Also: `chat-with-ai` takes **one prompt string**, not a message array. A conversation
becomes a role-tagged transcript (`[System]` / `[User]` / `[Assistant]`), and a lone user
message is passed through as written.

### Tool calls

`chat-with-ai` has no tool protocol, so when a request offers tools the plugin describes
them in the prompt and asks for a fenced `{"tool_calls":[{"name":…,"arguments":{…}}]}`
block, which it parses back into OpenAI `tool_calls`. Because a call can only be read out
of a *finished* reply, a request with tools is not streamed from the vendor — the whole
reply arrives, then goes to the client as a stream.

Turn it off with the **Emulate tool calls** switch in the provider's editor if you'd
rather the model never see a tool schema.

### What it can't do

- **Images.** `chat-with-ai` takes images only through 1min's own asset API, so an
  image a request carries is dropped with an `[image omitted]` marker. Fable itself
  accepts images upstream; the bridge has no way to hand them over.
- **Exact token counts.** `usage` comes from 1min's `metadata` (`promptToken`,
  `outputToken`, `totalToken`), which is 1min's count, not the provider's.
- **Reasoning in streams with tools.** The tool lane waits for the whole reply, so
  reasoning arrives with it rather than as it happens.

## Cost

1min charges **credits**, not tokens, and the Fable models are not included in any plan:
Fable 5.2 bills 8.8 credits per input token and 44 per output token. A one-line reply
costs a few thousand credits. Check your team balance before pointing an agent at it —
an exhausted team answers `INSUFFICIENT_CREDITS`, which this plugin surfaces as a `429`
with the vendor's own message.

## Development

```bash
node --test ./test/plugin.test.mjs
```

The tests use captured 1min response envelopes (success and failure) as fixtures, so they
run offline and spend nothing.

## Layout

```
index.mjs            the plugin: config, auth, provider.models
lib/onemin.mjs       the bridge, the catalogs, the shape translators
test/plugin.test.mjs 39 tests, no network
```

## License

MIT
