# llm-tape

Record and replay LLM API calls in tests, like VCR but built for model APIs. Zero dependencies.

- **First run** calls the real API and saves the response to disk.
- **Every run after** replays it instantly, for free, with no API key.
- **Change a prompt** and the test fails with a message that shows exactly what changed.

Works with the OpenAI, Anthropic and Gemini SDKs, or anything that uses `fetch`. Streaming responses are recorded chunk by chunk, and can be replayed at their original timing.

## Install

```sh
npm install --save-dev llm-tape
```

Node 22 or newer.

## Quick start

```js
import Anthropic from "@anthropic-ai/sdk";
import { withTape } from "llm-tape";

const client = withTape(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "replay" }), "tests/cassettes");

const reply = await client.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "Say hi" }],
});
```

Commit the `tests/cassettes` folder. In CI the recordings replay and no key is needed (the SDK only wants a placeholder string).

### OpenAI

```js
import OpenAI from "openai";
import { withTape } from "llm-tape";

const client = withTape(new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "replay" }), "tests/cassettes");
```

### Gemini, or any other client

`@google/genai` uses the global `fetch`, so patch that for the duration of your tests:

```js
import { installTape } from "llm-tape";

const restore = installTape("tests/cassettes");
// ... run tests ...
restore();
```

Or hand a tape to any client that takes a `fetch` option, or call it directly:

```js
import { tapeFetch } from "llm-tape";

const fetch = tapeFetch("tests/cassettes");
const client = new OpenAI({ fetch });
```

## Modes

| Mode | What it does |
| --- | --- |
| `auto` | Replay when a recording exists, otherwise call the API and record it. The default locally. |
| `replay` | Never touch the network. A request with no recording fails. The default when `CI` is set. |
| `record` | Always call the API and overwrite the recording. |
| `passthrough` | Call the API and save nothing. |

Set the mode with the `mode` option, or the `LLM_TAPE` environment variable. `RECORD=1` is a shortcut for `LLM_TAPE=record`:

```sh
RECORD=1 npm test
```

## When a request no longer matches

Requests are keyed by a hash of the method, URL and JSON body (key order ignored, headers ignored). If you change a prompt, the request has no recording, and in replay mode the call fails with:

```text
llm-tape: no recording for POST https://api.anthropic.com/v1/messages (key 47787088e78b2a6f) in tests/cassettes.
Closest recording: api_anthropic_com_v1_messages-7c1d0e9a3b2f4a61.json. The request changed at:
  messages[0].content: "Say hi" -> "Say hello"
To record it, run once with LLM_TAPE=record (or RECORD=1) and a real API key.
```

The failure comes back as a `400` response (with `x-should-retry: false`), so the SDKs raise it as a normal API error straight away instead of retrying a "connection error". The message is also printed to stderr.

## Secrets

Request headers are never saved, so API keys sent in headers never reach disk. On top of that, llm-tape strips these from saved files and from the request key:

- `key`, `api_key`, `access_token` and `token` query parameters (Gemini's `?key=`)
- strings that look like keys: `sk-...`, `sk-ant-...`, `AIza...`, `Bearer ...`
- the values of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY`
- anything you pass in `redact`

Non-2xx responses are not recorded by default, so a bad key never becomes a recording.

## Options

```ts
tapeFetch({
  dir: "tests/cassettes",   // where recordings live
  mode: "auto",             // see Modes
  fetch: globalThis.fetch,  // the fetch that makes real calls
  timing: "instant",        // or "realistic" to replay stream chunks at recorded speed
  recordErrors: false,      // also save non-2xx responses
  redact: ["my-org-id", /internal-[0-9]+/],
});
```

`withTape(client, options)` and `installTape(options)` take the same options, or just the folder as a string.

## Recording format

One readable JSON file per request, named `<host_path>-<hash>.json`:

```json
{
  "version": 1,
  "request": { "method": "POST", "url": "https://api.openai.com/v1/chat/completions", "body": { "model": "...", "messages": [] } },
  "response": { "status": 200, "statusText": "OK", "headers": { "content-type": "application/json" }, "body": { "choices": [] } }
}
```

Streamed responses store `chunks: [{ "delay": 312, "text": "data: ...\n\n" }]` instead of `body`.

## Build from source

```sh
git clone https://github.com/acus9345/llm-tape.git
cd llm-tape
npm install
npm test
```

## Troubleshooting

- **`withTape(client): this client has no fetch property`**: the client doesn't keep its fetch on `client.fetch`. Use `installTape()` or pass `tapeFetch()` as the client's `fetch` option.
- **A test records every time**: something in the request body changes on each run (a timestamp, a random id). Keep test inputs fixed.
- **The SDK complains about a missing API key in CI**: pass a placeholder like `apiKey: "replay"`. It is never sent anywhere in replay mode.

## License

MIT
