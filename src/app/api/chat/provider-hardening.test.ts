import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ responses: vi.fn(), completions: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  responses = { create: mocks.responses };
  chat = { completions: { create: mocks.completions } };
} }));
const FAKE_SECRET = "fake-secret-provider-key-and-private-request";
const REQUEST_ERROR = "The model provider is unavailable.";
const STREAM_ERROR = "The model response could not be completed.";
const PROGRAM = "root = Col([])";
let logs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules(); mocks.responses.mockReset(); mocks.completions.mockReset();
  for (const name of ["MODEL_PROVIDER", "OLLAMA_MODEL", "LLM_REASONING_EFFORT"]) vi.stubEnv(name, "");
  vi.stubEnv("LLM_BASE_URL", "https://fixture.invalid/v1"); vi.stubEnv("LLM_MODEL", "fixture-model"); vi.stubEnv("LLM_API_KEY", "fixture-model-key");
  vi.stubEnv("THESYS_API_KEY", "fixture-cloud-key"); vi.stubEnv("THESYS_MODEL", "fixture-cloud-model");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No live calls permitted in provider tests"); }));
  logs = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function post() {
  const { POST } = await import("./route");
  return POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Unit fixture request" }] }) }));
}
async function events(response: Response) {
  const text = await response.text();
  expect(text).not.toContain(FAKE_SECRET);
  return text.split("\n\n").filter(Boolean).map((line) => JSON.parse(line.slice(6)));
}
const chunks = (values: unknown[]) => (async function* () { for (const value of values) yield value; })();
const chunk = (content?: string | null, finish_reason?: string | null) => ({ choices: [{ delta: { content }, finish_reason }] });
const failure = (status: unknown) => Object.assign(new Error(FAKE_SECRET), { status, headers: { Authorization: FAKE_SECRET }, request: { apiKey: FAKE_SECRET } });
const useCloud = () => vi.stubEnv("LLM_BASE_URL", "");
function assertSafeLogs(kind: "direct" | "cloud", status: number) {
  expect(logs).toHaveBeenCalledTimes(1);
  expect(logs).toHaveBeenCalledWith({ providerKind: kind, status });
  expect(JSON.stringify(logs.mock.calls)).not.toContain(FAKE_SECRET);
}
function assertStreamFailure(output: Array<{ type: string; message?: string }>) {
  expect(output.at(-1)).toEqual({ type: "error", message: STREAM_ERROR });
  expect(output.some((event) => event.type === "response.output_text.done" || event.type === "response.completed")).toBe(false);
}

describe("ordinary provider error secrecy", () => {
  it.each(["direct", "cloud"] as const)("returns fixed pre-stream error and allowlisted %s log", async (kind) => {
    if (kind === "cloud") useCloud();
    (kind === "cloud" ? mocks.responses : mocks.completions).mockRejectedValue(failure(401));
    const response = await post();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: REQUEST_ERROR } });
    assertSafeLogs(kind, 401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["429", 200, 700, Number.NaN, undefined])("rejects unallowlisted diagnostic status %s", async (status) => {
    mocks.completions.mockRejectedValue(failure(status));
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: REQUEST_ERROR } });
    assertSafeLogs("direct", 502);
  });
  it.each(["direct", "cloud"] as const)("sanitizes a thrown %s midstream exception after real deltas", async (kind) => {
    if (kind === "cloud") useCloud();
    const stream = (async function* () {
      yield kind === "direct" ? chunk("root = ") : { type: "response.output_text.delta", delta: "root = " };
      throw failure(503);
    })();
    (kind === "cloud" ? mocks.responses : mocks.completions).mockResolvedValue(stream);
    const response = await post();
    expect(response.status).toBe(200);
    const output = await events(response);
    expect(output.some((event) => event.type === "response.output_text.delta")).toBe(true);
    assertStreamFailure(output);
    assertSafeLogs(kind, 503);
  });
  it.each(["error", "response.failed", "response.incomplete"])("does not relay raw Cloud failure event %s", async (type) => {
    useCloud();
    mocks.responses.mockResolvedValue(chunks([
      { type: "response.output_text.delta", delta: "root = " },
      { type, message: FAKE_SECRET, error: { message: FAKE_SECRET }, response: { error: { message: FAKE_SECRET } } },
      { type: "response.completed" },
    ]));
    assertStreamFailure(await events(await post()));
    assertSafeLogs("cloud", 502);
  });
});

describe("ordinary direct completion semantics", () => {
  it.each(["length", "content_filter", "tool_calls", "function_call", "future_nonstop_reason"])("fails safely on explicit terminal reason %s", async (reason) => {
    mocks.completions.mockResolvedValue(chunks([chunk("root = "), chunk("discarded terminal text", reason)]));
    const output = await events(await post());
    expect(output.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta)).toEqual(["root = "]);
    assertStreamFailure(output);
    assertSafeLogs("direct", 502);
  });
  it.each([
    [],
    [chunk(null, "stop")],
    [chunk(" \n\t", "stop")],
    [{ choices: [] }],
    [{ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }],
    [{ choices: [{ delta: { tool_calls: [{ id: "fixture-tool", function: { name: "unused", arguments: FAKE_SECRET } }] }, finish_reason: null }] }],
  ].map((values) => ({ values })))("never successfully completes empty/whitespace/tool-only output %#", async ({ values }) => {
    mocks.completions.mockResolvedValue(chunks(values));
    assertStreamFailure(await events(await post()));
    assertSafeLogs("direct", 502);
  });
  it.each(["stop", null, undefined])("preserves successful SSE exactly with terminal reason %s", async (reason) => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    mocks.completions.mockResolvedValue(chunks([chunk("root = "), chunk("Col([])"), chunk(null, reason)]));
    const response = await post();
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await events(response)).toEqual([
      { type: "response.output_item.added", item: { id: "msg_123", type: "message", role: "assistant", content: [], status: "in_progress" }, output_index: 0 },
      { type: "response.output_text.delta", item_id: "msg_123", output_index: 0, content_index: 0, delta: "root = " },
      { type: "response.output_text.delta", item_id: "msg_123", output_index: 0, content_index: 0, delta: "Col([])" },
      { type: "response.output_text.done", item_id: "msg_123", output_index: 0, content_index: 0, text: PROGRAM },
      { type: "response.completed" },
    ]);
    expect(logs).not.toHaveBeenCalled();
  });
  it("delivers direct text before the provider iterator completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.completions.mockResolvedValue((async function* () {
      yield chunk("root = ");
      await gate;
      yield chunk("Col([])", "stop");
    })());
    const response = await post();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("response.output_item.added");
    expect(decoder.decode((await reader.read()).value)).toContain('"delta":"root = "');
    release();
    let tail = "";
    while (true) { const item = await reader.read(); if (item.done) break; tail += decoder.decode(item.value); }
    expect(tail).toContain("response.completed"); expect(logs).not.toHaveBeenCalled();
  });
  it("passes successful Cloud events through unchanged", async () => {
    useCloud();
    const supplied = [
      { type: "response.output_item.added", output_index: 0, item: { id: "cloud-fixture", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "cloud-fixture", output_index: 0, content_index: 0, delta: PROGRAM },
      { type: "response.output_text.done", item_id: "cloud-fixture", output_index: 0, content_index: 0, text: PROGRAM },
      { type: "response.completed", response: { status: "completed", usage: { output_tokens: 5 } } },
    ];
    mocks.responses.mockResolvedValue(chunks(supplied));
    expect(await events(await post())).toEqual(supplied);
    expect(logs).not.toHaveBeenCalled(); expect(mocks.completions).not.toHaveBeenCalled();
  });
});
