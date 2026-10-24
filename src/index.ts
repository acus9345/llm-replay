import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * - `auto`: replay when a recording exists, otherwise call the API and record it.
 * - `record`: always call the API and overwrite the recording.
 * - `replay`: never touch the network; a request without a recording fails.
 * - `passthrough`: call the API and save nothing.
 */
export type TapeMode = "auto" | "record" | "replay" | "passthrough";

export interface TapeOptions {
  /** Folder that holds the recordings, e.g. "tests/cassettes". */
  dir: string;
  /** Defaults to LLM_REPLAY, then `record` if RECORD=1, then `replay` on CI, else `auto`. */
  mode?: TapeMode;
  /** The fetch that makes real calls. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** `realistic` replays streamed chunks with their recorded delays. Default `instant`. */
  timing?: "instant" | "realistic";
  /** Save non-2xx responses too. Off by default so a 401 never becomes a recording. */
  recordErrors?: boolean;
  /** Extra secrets to strip from saved files and from the request key. */
  redact?: (string | RegExp)[];
}

interface Chunk {
  delay: number;
  text: string;
}

interface Recording {
  version: 1;
  request: { method: string; url: string; body: unknown };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: unknown;
    text?: string;
    chunks?: Chunk[];
  };
}

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{10,}=*/g,
];
const SECRET_PARAMS = /^(key|api[_-]?key|access[_-]?token|token|auth)$/i;
const SECRET_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const DROPPED_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);
const REDACTED = "[REDACTED]";

/** Build a fetch that records responses to `dir` and replays them on later runs. */
export function tapeFetch(options: TapeOptions | string): typeof fetch {
  const opts = typeof options === "string" ? { dir: options } : options;
  const mode = resolveMode(opts.mode);
  const realFetch = opts.fetch ?? globalThis.fetch;
  const redact = makeRedactor(opts.redact ?? []);

  return async function tape(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (mode === "passthrough") return realFetch(input, init);

    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    const url = redactUrl(request.url, redact);
    const body = parseBody(redact(await request.clone().text()));
    const key = requestKey(method, url, body);
    const file = join(opts.dir, `${slug(url)}-${key}.json`);

    if (mode === "replay" || (mode === "auto" && existsSync(file))) {
      if (!existsSync(file)) return missing(opts.dir, method, url, body, key);
      const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
      return replay(recording, opts.timing ?? "instant");
    }

    const started = performance.now();
    // A stream body can only be read once, and the Request above already owns it.
    const res = init?.body instanceof ReadableStream ? await realFetch(request) : await realFetch(input, init);
    if (!res.ok && !opts.recordErrors) return res;

    const save = (response: Partial<Recording["response"]>) => {
      const recording: Recording = {
        version: 1,
        request: { method, url, body },
        response: {
          status: res.status,
          statusText: res.statusText,
          headers: savedHeaders(res.headers, redact),
          ...response,
        },
      };
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(file, redact(JSON.stringify(recording, null, 2)) + "\n");
    };

    const type = res.headers.get("content-type") ?? "";
    if (res.body && /event-stream|ndjson/i.test(type)) {
      return recordStream(res, started, (chunks) => save({ chunks }));
    }

    const text = await res.text();
    const json = /json/i.test(type) ? tryParse(text) : undefined;
    save(json === undefined ? { text } : { body: json });
    return new Response(nullBodyStatus(res.status) ? null : text, {
      status: res.status,
      statusText: res.statusText,
      headers: cleanHeaders(res.headers),
    });
  };
}

/**
 * Point an OpenAI or Anthropic SDK client at a tape, in place. Both SDKs keep
 * their fetch on `client.fetch`. For other clients, pass `tapeFetch()` as the
 * constructor's `fetch` option, or use `installTape()`.
 */
export function withTape<T extends object>(client: T, options: TapeOptions | string): T {
  const target = client as { fetch?: unknown };
  if (typeof target.fetch !== "function") {
    throw new TypeError(
      "withTape(client): this client has no `fetch` property to replace. " +
        "Pass tapeFetch(dir) as the client's `fetch` option, or call installTape(dir) to patch globalThis.fetch.",
    );
  }
  const original = target.fetch as typeof fetch;
  const opts = typeof options === "string" ? { dir: options } : options;
  target.fetch = tapeFetch({ ...opts, fetch: opts.fetch ?? ((input, init) => original.call(undefined, input, init)) });
  return client;
}

/** Replace globalThis.fetch with a tape (for SDKs like @google/genai). Returns a function that restores it. */
export function installTape(options: TapeOptions | string): () => void {
  const original = globalThis.fetch;
  const opts = typeof options === "string" ? { dir: options } : options;
  globalThis.fetch = tapeFetch({ ...opts, fetch: opts.fetch ?? original });
  return () => {
    globalThis.fetch = original;
  };
}

function resolveMode(mode: TapeMode | undefined): TapeMode {
  if (mode) return mode;
  const env = process.env.LLM_REPLAY?.toLowerCase();
  if (env === "auto" || env === "record" || env === "replay" || env === "passthrough") return env;
  if (env) throw new TypeError(`LLM_REPLAY must be auto, record, replay or passthrough, got "${env}".`);
  if (process.env.RECORD === "1" || process.env.RECORD === "true") return "record";
  if (process.env.CI && process.env.CI !== "false") return "replay";
  return "auto";
}

function makeRedactor(extra: (string | RegExp)[]): (text: string) => string {
  const literals = [
    ...extra.filter((s): s is string => typeof s === "string"),
    ...SECRET_ENV.map((name) => process.env[name]).filter((v): v is string => !!v && v.length >= 8),
  ];
  const patterns = [...SECRET_PATTERNS, ...extra.filter((s): s is RegExp => s instanceof RegExp)];
  return (text) => {
    for (const literal of literals) text = text.split(literal).join(REDACTED);
    for (const pattern of patterns) {
      text = text.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"), REDACTED);
    }
    return text;
  };
}

function redactUrl(raw: string, redact: (text: string) => string): string {
  const url = new URL(raw);
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAMS.test(name)) url.searchParams.set(name, REDACTED);
  }
  return redact(url.toString());
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  const json = tryParse(text);
  return json === undefined ? text : json;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestKey(method: string, url: string, body: unknown): string {
  return createHash("sha256").update(`${method} ${url}\n${canonical(body)}`).digest("hex").slice(0, 16);
}

function slug(url: string): string {
  const { host, pathname } = new URL(url);
  return `${host}${pathname}`.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

function savedHeaders(headers: Headers, redact: (text: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!DROPPED_HEADERS.has(name)) out[name] = redact(value);
  });
  return out;
}

function cleanHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of DROPPED_HEADERS) if (name !== "set-cookie") out.delete(name);
  return out;
}

function nullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function recordStream(res: Response, started: number, save: (chunks: Chunk[]) => void): Response {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: Chunk[] = [];
  let last = started;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) chunks.push({ delay: 0, text: tail });
        save(chunks);
        controller.close();
        return;
      }
      const now = performance.now();
      chunks.push({ delay: Math.round(now - last), text: decoder.decode(value, { stream: true }) });
      last = now;
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: cleanHeaders(res.headers) });
}

function replay(recording: Recording, timing: "instant" | "realistic"): Response {
  const { status, statusText, headers, body, text, chunks } = recording.response;
  const init = { status, statusText, headers: { ...headers, "x-llm-replay": "replay" } };
  if (nullBodyStatus(status)) return new Response(null, init);
  if (!chunks) return new Response(text ?? JSON.stringify(body), init);

  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) return controller.close();
      const chunk = chunks[i++];
      if (timing === "realistic" && chunk.delay > 0) await new Promise((r) => setTimeout(r, chunk.delay));
      controller.enqueue(encoder.encode(chunk.text));
    },
  });
  return new Response(stream, init);
}

/**
 * A request with no recording. Returned as a 400 response rather than thrown,
 * so SDKs surface the message in their error instead of retrying a "connection error".
 */
function missing(dir: string, method: string, url: string, body: unknown, key: string): Response {
  const lines = [`llm-replay: no recording for ${method} ${url} (key ${key}) in ${dir}.`];
  const closest = closestRecording(dir, method, url, body);
  if (closest) {
    lines.push(`Closest recording: ${closest.file}. The request changed at:`, ...closest.diffs.map((d) => `  ${d}`));
  } else {
    lines.push("There are no recordings for this endpoint yet.");
  }
  lines.push("To record it, run once with LLM_REPLAY=record (or RECORD=1) and a real API key.");
  const message = lines.join("\n");
  console.error(message);
  return new Response(JSON.stringify({ type: "error", error: { type: "llm_replay_no_recording", message } }), {
    status: 400,
    statusText: "No Recording",
    headers: { "content-type": "application/json", "x-should-retry": "false", "x-llm-replay": "missing" },
  });
}

function closestRecording(dir: string, method: string, url: string, body: unknown) {
  if (!existsSync(dir)) return undefined;
  let best: { file: string; diffs: string[] } | undefined;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    let recording: Recording;
    try {
      recording = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (recording?.request?.method !== method || recording.request.url !== url) continue;
    const diffs: string[] = [];
    diff(recording.request.body, body, "", diffs);
    if (!best || diffs.length < best.diffs.length) best = { file, diffs };
  }
  return best;
}

const MAX_DIFFS = 5;

function diff(recorded: unknown, current: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_DIFFS || Object.is(recorded, current)) return;
  if (
    recorded &&
    current &&
    typeof recorded === "object" &&
    typeof current === "object" &&
    Array.isArray(recorded) === Array.isArray(current)
  ) {
    const a = recorded as Record<string, unknown>;
    const b = current as Record<string, unknown>;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diff(a[k], b[k], Array.isArray(recorded) ? `${path}[${k}]` : path ? `${path}.${k}` : k, out);
    }
    return;
  }
  out.push(`${path || "(body)"}: ${show(recorded)} -> ${show(current)}`);
}

function show(value: unknown): string {
  if (value === undefined) return "(missing)";
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
