import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tapeFetch, withTape, installTape } from "../dist/index.js";

const URL_ = "https://api.example.com/v1/messages";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "llm-tape-"));
}

function fakeFetch(makeResponse = () => Response.json({ text: "hi there" })) {
  const fn = async (input, init) => {
    fn.calls.push({ input, init });
    return makeResponse(input, init);
  };
  fn.calls = [];
  return fn;
}

function post(fetchFn, body, headers = {}) {
  return fetchFn(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function sseResponse(events, gapMs = 0) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (i >= events.length) return controller.close();
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(encoder.encode(`data: ${events[i++]}\n\n`));
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  delete process.env.LLM_TAPE;
  delete process.env.RECORD;
  delete process.env.CI;
});

test("records on the first call and replays after that", async () => {
  const dir = tempDir();
  const real = fakeFetch();
  const first = await post(tapeFetch({ dir, fetch: real }), { model: "m", prompt: "hello" });
  const second = await post(tapeFetch({ dir, fetch: real }), { model: "m", prompt: "hello" });

  assert.equal(real.calls.length, 1);
  assert.deepEqual(await first.json(), { text: "hi there" });
  assert.deepEqual(await second.json(), { text: "hi there" });
  assert.equal(second.headers.get("x-llm-tape"), "replay");
  assert.equal(readdirSync(dir).length, 1);
});

test("the key ignores headers and body key order but not body values", async () => {
  const dir = tempDir();
  const real = fakeFetch();
  const tape = tapeFetch({ dir, fetch: real });
  await post(tape, { model: "m", prompt: "a" }, { "x-api-key": "one" });
  await post(tape, { prompt: "a", model: "m" }, { "x-api-key": "two" });
  assert.equal(real.calls.length, 1);
  await post(tape, { model: "m", prompt: "b" });
  assert.equal(real.calls.length, 2);
});

test("replay mode fails with a message that shows what changed", async () => {
  const dir = tempDir();
  await post(tapeFetch({ dir, fetch: fakeFetch() }), { model: "m", messages: [{ content: "Hi" }] });

  const original = console.error;
  console.error = () => {};
  try {
    const res = await post(tapeFetch({ dir, mode: "replay", fetch: fakeFetch() }), {
      model: "m",
      messages: [{ content: "Hello" }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("x-should-retry"), "false");
    const { error } = await res.json();
    assert.equal(error.type, "llm_tape_no_recording");
    assert.match(error.message, /no recording for POST/);
    assert.match(error.message, /messages\[0\]\.content: "Hi" -> "Hello"/);
    assert.match(error.message, /LLM_TAPE=record/);
  } finally {
    console.error = original;
  }
});

test("CI defaults to replay mode and never calls the network", async () => {
  process.env.CI = "true";
  const real = fakeFetch();
  const original = console.error;
  console.error = () => {};
  try {
    const res = await post(tapeFetch({ dir: tempDir(), fetch: real }), { prompt: "x" });
    assert.equal(res.status, 400);
    assert.equal(real.calls.length, 0);
  } finally {
    console.error = original;
  }
});

test("RECORD=1 re-records an existing recording", async () => {
  const dir = tempDir();
  await post(tapeFetch({ dir, fetch: fakeFetch() }), { prompt: "x" });
  process.env.RECORD = "1";
  const real = fakeFetch(() => Response.json({ text: "new answer" }));
  await post(tapeFetch({ dir, fetch: real }), { prompt: "x" });
  delete process.env.RECORD;
  const res = await post(tapeFetch({ dir, fetch: fakeFetch() }), { prompt: "x" });
  assert.equal(real.calls.length, 1);
  assert.deepEqual(await res.json(), { text: "new answer" });
});

test("streams are recorded chunk by chunk and replayed identically", async () => {
  const dir = tempDir();
  const events = ['{"delta":"Hel"}', '{"delta":"lo"}', "[DONE]"];
  const live = await post(tapeFetch({ dir, fetch: fakeFetch(() => sseResponse(events)) }), { stream: true });
  const liveText = await live.text();

  const replayed = await post(tapeFetch({ dir, mode: "replay" }), { stream: true });
  assert.equal(replayed.headers.get("content-type"), "text/event-stream");
  assert.equal(await replayed.text(), liveText);

  const [file] = readdirSync(dir);
  const recording = JSON.parse(readFileSync(join(dir, file), "utf8"));
  assert.equal(recording.response.chunks.length, 3);
});

test("realistic timing waits between replayed chunks", async () => {
  const dir = tempDir();
  const events = ["1", "2", "3"];
  await (await post(tapeFetch({ dir, fetch: fakeFetch(() => sseResponse(events, 40)) }), { s: 1 })).text();

  let start = performance.now();
  await (await post(tapeFetch({ dir, mode: "replay" }), { s: 1 })).text();
  const instant = performance.now() - start;

  start = performance.now();
  await (await post(tapeFetch({ dir, mode: "replay", timing: "realistic" }), { s: 1 })).text();
  const realistic = performance.now() - start;

  assert.ok(instant < 40, `instant replay took ${instant}ms`);
  assert.ok(realistic >= 90, `realistic replay took ${realistic}ms`);
});

test("secrets are stripped from saved files", async () => {
  const dir = tempDir();
  process.env.OPENAI_API_KEY = "my-very-secret-env-key";
  const real = fakeFetch(() =>
    Response.json({ echo: "sk-ant-api03-abcdefghijklmnop", other: "my-very-secret-env-key" }),
  );
  const tape = tapeFetch({ dir, fetch: real, redact: ["internal-123"] });
  await tape("https://gen.example.com/v1/models:generate?key=AIzaSyA1234567890abcdefghijklmnopqrstu", {
    method: "POST",
    headers: { authorization: "Bearer sk-proj-abcdefghijklmnopqrstuvwxyz" },
    body: JSON.stringify({ note: "internal-123", token: "Bearer abcdefghijklmnop" }),
  });
  delete process.env.OPENAI_API_KEY;

  const saved = readFileSync(join(dir, readdirSync(dir)[0]), "utf8");
  for (const secret of ["sk-ant-api03", "my-very-secret", "AIzaSy", "internal-123", "abcdefghijklmnop", "sk-proj"]) {
    assert.ok(!saved.includes(secret), `saved file contains ${secret}`);
  }
  assert.match(saved, /key=%5BREDACTED%5D/);
});

test("error responses are passed through but not recorded by default", async () => {
  const dir = tempDir();
  const real = fakeFetch(() => Response.json({ error: "bad key" }, { status: 401 }));
  const res = await post(tapeFetch({ dir, fetch: real }), { prompt: "x" });
  assert.equal(res.status, 401);
  assert.equal(readdirSync(dir).length, 0);

  await post(tapeFetch({ dir, fetch: real, recordErrors: true }), { prompt: "x" });
  assert.equal(readdirSync(dir).length, 1);
});

test("withTape swaps an SDK client's fetch in place", async () => {
  const dir = tempDir();
  const real = fakeFetch();
  const client = { fetch: real };
  assert.equal(withTape(client, dir), client);
  await post(client.fetch, { prompt: "x" });
  await post(client.fetch, { prompt: "x" });
  assert.equal(real.calls.length, 1);
  assert.throws(() => withTape({}, dir), /tapeFetch\(dir\)/);
});

test("installTape patches and restores globalThis.fetch", async () => {
  const original = globalThis.fetch;
  const real = fakeFetch();
  const restore = installTape({ dir: tempDir(), fetch: real });
  try {
    assert.notEqual(globalThis.fetch, original);
    await post(globalThis.fetch, { prompt: "x" });
    await post(globalThis.fetch, { prompt: "x" });
    assert.equal(real.calls.length, 1);
  } finally {
    restore();
  }
  assert.equal(globalThis.fetch, original);
});

test("an invalid LLM_TAPE value is rejected", () => {
  process.env.LLM_TAPE = "sometimes";
  assert.throws(() => tapeFetch(tempDir()), /LLM_TAPE must be/);
});
