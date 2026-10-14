import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSearchAdmissionState, normalizeResults, safeSourceUrl, searchValyu, VALYU_ENDPOINT } from "./valyu";
import { instant, representativeVerifiedResponseShape, vendorEnvelope, vendorResult } from "./test-fixtures";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const signal = () => new AbortController().signal;
const config = () => ({ enabled: true, apiKey: "fixture-key", state: newSearchAdmissionState() });
const mockResponse = (value: unknown, status = 200, headers?: HeadersInit) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(value, { status, headers }));

describe("display-only source normalization", () => {
  it.each(["http://example.org", "javascript:alert(1)", "https://user:pass@example.org/", "https://localhost/", "https://a.local/", "https://127.1/", "https://10.0.0.1/", "https://172.16.0.1/", "https://192.168.1.1/", "https://169.254.169.254/", "https://100.64.0.1/", "https://[::1]/", "https://2130706433/", "https://example.org:8443/", "https://example.org/\n", "https://example.org/" + "x".repeat(2049)])("rejects unsafe URL %s", (url) => {
    expect(safeSourceUrl(url)).toBeNull();
  });
  it("preserves path/query/fragment, dedupes fragment variants, then assigns canonical IDs", () => {
    const { sources, partial } = normalizeResults([
      vendorResult({ title: "<b>Museum</b>", content: "**Exhibits** [details](https://other.org)\u0000" }),
      vendorResult({ id: "different", url: "https://example.org/museum?lang=en#other" }),
      vendorResult({ url: "https://example.org/second", publication_date: "", relevance_score: 0.7 }),
    ], instant);
    expect(partial).toBe(true);
    expect(sources.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(sources[0]).toMatchObject({ title: "Museum", excerpt: "Exhibits details", url: "https://example.org/museum?lang=en#exhibits", retrievedAt: instant, publicationDate: null, relevanceScore: null });
    expect(sources[1].relevanceScore).toBe(0.7);
  });
  it("retains at most three and inspects at most twenty", () => {
    const results = Array.from({ length: 21 }, (_, i) => vendorResult({ url: `https://example.org/${i}` }));
    const result = normalizeResults(results, instant);
    expect(result.sources.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(result.partial).toBe(true);
  });
  it("rejects non-web/non-text and invalid pricing/relevance; bounds Unicode text", () => {
    const result = normalizeResults([
      vendorResult({ data_type: "structured" }), vendorResult({ source_type: "proprietary" }), vendorResult({ source: "proprietary" }),
      vendorResult({ price: -1 }), vendorResult({ relevance_score: 2 }), vendorResult({ content: "" }),
      vendorResult({ title: "😀".repeat(250), content: "😀".repeat(1700), publication_date: "not-a-date" }),
    ], instant);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toHaveLength(200);
    expect(Array.from(result.sources[0].title)).toHaveLength(100);
    expect(result.sources[0].excerpt).toHaveLength(1500);
    expect(Array.from(result.sources[0].excerpt)).toHaveLength(750);
    expect(result.sources[0].source).toBe("web");
    expect(result.sources[0].publicationDate).toBeNull();
  });
  it.each(["website", "forum"])("accepts documented unstructured web classification %s", (source_type) => {
    const result = normalizeResults([vendorResult({ source_type })], instant);
    expect(result.partial).toBe(false);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ id: "s1", source: "web", excerpt: "Hands-on science exhibits." });
  });
  it("rejects the old incorrect source_type web rather than confusing it with the category", () => {
    expect(normalizeResults([vendorResult({ source_type: "web" })], instant)).toEqual({ sources: [], partial: true });
  });
});

describe("one bounded Search", () => {
  it("sends exact fixed HTTPS request with server-only header, no redirects/retries", async () => {
    const fetch = mockResponse(vendorEnvelope());
    const result = await searchValyu("  fixture question  ", signal(), { ...config(), fetch });
    expect(result.status).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(VALYU_ENDPOINT);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "x-api-key": "fixture-key", "Content-Type": "application/json" } });
    expect(JSON.parse(init!.body as string)).toEqual({ query: "fixture question", search_type: "web", max_num_results: 3, response_length: 1500, max_price: 4.5, relevance_threshold: 0.5, is_tool_call: true, fast_mode: false });
  });
  it("regresses a representative verified response shape using synthetic data and admits its reported cost offline", async () => {
    const representative = representativeVerifiedResponseShape;
    expect(representative.results.map((r) => [r.source, r.source_type, r.data_type])).toEqual([
      ["web", "forum", "unstructured"], ["web", "forum", "unstructured"], ["web", "website", "unstructured"],
    ]);
    const normalized = normalizeResults(representative.results, instant);
    expect(normalized.sources.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(normalized.sources.every((s) => s.excerpt.length <= 1500 && s.url.startsWith("https://"))).toBe(true);
    const state = newSearchAdmissionState();
    const fetch = mockResponse(representative);
    const result = await searchValyu("fixture question", signal(), { ...config(), state, fetch });
    expect(result.status).toBe("ready"); expect(result.sources).toHaveLength(3);
    expect(state).toMatchObject({ admitted: 1, reservedDollars: 0.02, reportedDollars: 0.0045, disabled: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).max_price).toBe(4.5);
    expect(console.warn).not.toHaveBeenCalled();
  });
  it.each([{ enabled: false, apiKey: "fixture-key" }, { enabled: true, apiKey: "" }, { enabled: true, apiKey: "bad\r\nheader" }])("configuration admission is enforced before fetch", async (settings) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect((await searchValyu("fixture", signal(), { ...config(), ...settings, fetch })).error?.code).toBe("not_configured");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("missing environment key yields not_configured", async () => {
    vi.stubEnv("VALYU_RESEARCH_ENABLED", "true"); vi.stubEnv("VALYU_API_KEY", "");
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect((await searchValyu("fixture", signal(), { fetch })).error?.code).toBe("not_configured");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[401, "unavailable"], [402, "unavailable"], [403, "unavailable"], [400, "upstream_error"], [500, "upstream_error"], [302, "upstream_error"], [429, "rate_limited"]])("sanitizes status %i without retries", async (status, code) => {
    const fetch = mockResponse({ success: false, error: "private upstream data fixture-key" }, status as number, { "Retry-After": "99999" });
    const result = await searchValyu("fixture", signal(), { ...config(), fetch });
    expect(result.error?.code).toBe(code);
    if (status === 429) expect(result.error?.retryAfterSeconds).toBe(3600);
    expect(JSON.stringify(result)).not.toMatch(/private|fixture-key/);
    expect(console.warn).toHaveBeenCalledWith({ provider: "valyu", phase: "http", status });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private|fixture-key/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["ENOTFOUND", "ECONNRESET", "ERR_TLS_CERT_ALTNAME_INVALID", "private-cause-fixture-key"])("logs only an allowlisted native cause for %s", async (code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("private exception fixture-key", {
      cause: { code, message: "private cause fixture-key", headers: { "x-api-key": "fixture-key" } },
    }));
    const result = await searchValyu("fixture", signal(), { ...config(), fetch });
    expect(result.error?.code).toBe("upstream_error");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith({ provider: "valyu", phase: "fetch_or_read", cause: code.startsWith("private") ? "unknown" : code });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private|fixture-key|headers/);
    expect(JSON.stringify(result)).not.toMatch(/private|fixture-key/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([200, 206])("returns empty without inventing sources on %i", async (status) => {
    const result = await searchValyu("fixture", signal(), { ...config(), fetch: mockResponse(vendorEnvelope({ results: [] }), status) });
    expect(result.status).toBe("empty"); expect(result.sources).toEqual([]); expect(result.partial).toBe(status === 206);
  });
  it("labels partial successes/warnings and rejects success:false", async () => {
    const partial = await searchValyu("fixture", signal(), { ...config(), fetch: mockResponse(vendorEnvelope({ warnings: ["private warning"] }), 206) });
    expect(partial.partial).toBe(true); expect(partial.status).toBe("ready"); expect(JSON.stringify(partial)).not.toContain("private warning");
    expect((await searchValyu("fixture", signal(), { ...config(), fetch: mockResponse(vendorEnvelope({ success: false })) })).error?.code).toBe("upstream_error");
  });
  it.each([{}, { total_deduction_dollars: -1 }, { total_deduction_dollars: "0.001" }])("invalid/missing costs disable later admissions", async (envelope) => {
    const state = newSearchAdmissionState(); const fetch = mockResponse(envelope);
    expect((await searchValyu("fixture", signal(), { ...config(), state, fetch })).error?.code).toBe("invalid_upstream");
    expect((await searchValyu("fixture", signal(), { ...config(), state, fetch })).error?.code).toBe("budget_exceeded");
    expect(fetch).toHaveBeenCalledTimes(1); expect(state.reservedDollars).toBe(0.02);
  });
  it("reported over-budget cost trips circuit after charging, never claims a refund", async () => {
    const state = newSearchAdmissionState(); const fetch = mockResponse(vendorEnvelope({ total_deduction_dollars: 0.03 }));
    expect((await searchValyu("fixture", signal(), { ...config(), state, fetch })).error?.code).toBe("budget_exceeded");
    expect(state).toMatchObject({ disabled: true, reportedDollars: 0.03, reservedDollars: 0.02 });
  });
  it("rejects non-JSON and oversized streamed bytes", async () => {
    for (const body of ["not JSON", "x".repeat(256 * 1024 + 1)]) {
      const state = newSearchAdmissionState();
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
      expect((await searchValyu("fixture", signal(), { ...config(), state, fetch })).error?.code).toBe("invalid_upstream");
      expect(state.disabled).toBe(true);
    }
  });
  it("deadline covers body reading and cancels underlying reader", async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const pending = searchValyu("fixture", signal(), { ...config(), fetch });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).error?.code).toBe("timeout"); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("browser cancellation propagates and is not a successful snapshot", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")));
    }));
    const pending = searchValyu("fixture", controller.signal, { ...config(), fetch });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await assertion;
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it("enforces in-flight and lifetime admissions without fetching", async () => {
    const state = newSearchAdmissionState(); const fetch = mockResponse(vendorEnvelope());
    state.inFlight = true;
    expect((await searchValyu("fixture", signal(), { ...config(), state, fetch })).error?.code).toBe("rate_limited");
    state.inFlight = false; state.admitted = 50;
    expect((await searchValyu("fixture", signal(), { ...config(), state, fetch })).error?.code).toBe("budget_exceeded");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects overlong queries before any fetch", async () => {
    const fetch = mockResponse(vendorEnvelope());
    await expect(searchValyu("😀".repeat(401), signal(), { ...config(), fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
