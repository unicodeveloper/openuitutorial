import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createParser, type LibrarySpec } from "@openuidev/lang-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import spec from "@/generated/research-library-spec.json";
import { researchExample } from "../research-prompt-options";
import type { EvidenceSnapshot, EvidenceSource } from "../research/types";
import {
  acquireSnapshot, evidenceSnapshotSchema, researchOptionsSchema, ResearchComparisonView,
  resolveClaim, toggleSelection, validSelection, type ResearchOption, type SnapshotRead,
} from "./research-comparison";

const id = "0123456789abcdef0123456789abcdef";
const otherId = "1123456789abcdef0123456789abcdef";
const source: EvidenceSource = {
  id: "s1", title: "Science museum source", url: "https://example.org/science?topic=family",
  source: "example.org", excerpt: "The museum has hands-on science exhibits.",
  publicationDate: null, retrievedAt: "2026-10-14T10:00:00.000Z", relevanceScore: null,
};
const option: ResearchOption = {
  id: "c1", label: "Science museum", claims: [{ criterion: "Activities", statement: "Hands-on science exhibits.", sourceIds: ["s1"], evidenceStatus: "supported" }],
};
const ready = (): EvidenceSnapshot => ({
  version: 1, snapshotId: id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(),
  status: "ready", partial: false, sources: [source], error: null,
});
const render = (read: SnapshotRead, options = [option], extra = {}) => renderToStaticMarkup(createElement(ResearchComparisonView, {
  read, options, selectedIds: [], onSelect: vi.fn(), ...extra,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("restricted research library and OpenUI parser", () => {
  const library: LibrarySpec = spec;
  const parser = createParser(library.schema!, library.root);
  it("exposes only Col and ResearchComparison with the current positional contract", () => {
    expect(library.root).toBe("Col");
    expect(Object.keys(library.schema!.$defs!)).toEqual(expect.arrayContaining(["Col", "ResearchComparison"]));
    expect(Object.keys(library.schema!.$defs!).filter((key) => !["Col", "ResearchComparison"].includes(key))).toEqual([]);
    expect(Object.keys(library.actions ?? {})).toEqual([]);
    expect(Object.keys(library.functions ?? {})).toEqual([]);
  });
  it("parses the exact example and preserves its reactive selection", () => {
    const result = parser.parse(researchExample);
    expect(result.meta.errors).toEqual([]);
    expect(result.meta.unresolved).toEqual([]);
    expect(result.meta.orphaned).toEqual([]);
    expect(result.meta.incomplete).toBe(false);
    expect(result.root?.typeName).toBe("Col");
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('"snapshotId":"' + id + '"');
    expect(serialized).toContain('"options":');
    expect(serialized).toContain('"selectedIds":');
    expect(serialized).toContain('"title":"Choose a family afternoon"');
    expect(serialized).not.toMatch(/Query|Mutation/);
  });
  it("accepts deterministic zero-option states and tolerates streaming prefixes", () => {
    const empty = `root = Col([comparison])\n$selectedIds = []\ncomparison = ResearchComparison("${id}", [], $selectedIds)`;
    expect(parser.parse(empty).meta.errors).toEqual([]);
    for (let end = 1; end < researchExample.length; end += 17) {
      expect(() => parser.parse(researchExample.slice(0, end))).not.toThrow();
    }
  });
});

describe("component boundary and local state", () => {
  it("rejects extra URL/action fields, excessive options, duplicate IDs, empty and incomplete claims", () => {
    expect(researchOptionsSchema.safeParse([option]).success).toBe(true);
    for (const value of [undefined, [{ label: "partial" }], [{ ...option, url: "https://invented.example" }],
      [{ ...option, action: "@OpenUrl" }], [option, option], [option, option, option, option],
      [{ ...option, claims: [] }], [{ ...option, claims: [{ ...option.claims[0], sourceIds: [] }] }],
      [{ ...option, claims: [{ ...option.claims[0], sourceIds: ["s1", "s1"] }] }]]) {
      expect(researchOptionsSchema.safeParse(value).success).toBe(false);
    }
  });
  it("keeps selection distinct, bounded and scoped to current option IDs", () => {
    const second: ResearchOption = { ...option, id: "c2", label: "Second" };
    const options = [option, second];
    expect(validSelection(["c1", "c1", "missing", 1, "c2"], options)).toEqual(["c1", "c2"]);
    const selected = toggleSelection([], "c1", options);
    expect(toggleSelection(selected, "c2", options)).toEqual(["c1", "c2"]);
    expect(toggleSelection(selected, "c1", options)).toEqual([]);
    expect(toggleSelection(selected, "missing", options)).toEqual(["c1"]);
    expect(validSelection(selected, [second])).toEqual([]);
  });
  it("never substitutes a different source for an unknown ID", () => {
    expect(resolveClaim(option.claims[0], [source]).sources[0].url).toBe(source.url);
    expect(resolveClaim({ ...option.claims[0], sourceIds: ["s2"] }, [source])).toEqual({ status: "unsupported", sources: [] });
    expect(resolveClaim({ ...option.claims[0], sourceIds: ["s1", "s2"] }, [source]).sources).toEqual([]);
    expect(resolveClaim({ ...option.claims[0], evidenceStatus: "uncertain" }, [source]).status).toBe("uncertain");
  });
  it("uses escaped text, canonical anchors, native disclosures and accessible shortlist controls", () => {
    const snapshot = ready();
    const html = render({ status: "loaded", snapshot }, [{ ...option, label: "<img src=x onerror=alert(1)>", claims: [{ ...option.claims[0], statement: "https://invented.example <script>alert(1)</script>" }] }]);
    expect(html).toContain('href="https://example.org/science?topic=family"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Add to shortlist");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="https://invented.example');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
  it("marks unknown evidence unsupported and omits its statement and links", () => {
    const html = render({ status: "loaded", snapshot: ready() }, [{ ...option, claims: [{ ...option.claims[0], statement: "Invented fact", sourceIds: ["s2"] }] }]);
    expect(html).toContain("Unsupported evidence");
    expect(html).not.toContain("Invented fact");
    expect(html).not.toContain("href=");
  });
  it("renders uncertainty and partial evidence without claiming verification", () => {
    const html = render({ status: "loaded", snapshot: { ...ready(), partial: true } }, [{ ...option, claims: [{ ...option.claims[0], evidenceStatus: "uncertain" }] }]);
    expect(html).toContain("Uncertain · check the source");
    expect(html).toContain("Some sources were unavailable");
  });
  it("disables shortlist edits during streaming and shows the selected count", () => {
    const html = render({ status: "loaded", snapshot: ready() }, [option], { streaming: true, selectedIds: ["c1"] });
    expect(html).toContain("1 of 1 shortlisted");
    expect(html).toContain('disabled=""');
    expect(html).toContain("still coming together");
  });
  it.each(["loading", "expired", "unavailable", "timeout"] as const)("renders %s without source-dependent controls", (status) => {
    const html = render({ status });
    expect(html).not.toContain("href=");
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('role="status"');
  });
  it("renders empty, malformed-option and safe server-error states", () => {
    const base = ready();
    expect(render({ status: "loaded", snapshot: { ...base, status: "empty", sources: [], error: null } })).toContain("No usable sources");
    expect(render({ status: "loaded", snapshot: base }, [], { invalid: true })).toContain("unsupported option data");
    const html = render({ status: "loaded", snapshot: { ...base, status: "error", sources: [], error: { code: "rate_limited", retryAfterSeconds: 30 } } });
    expect(html).toContain("Wait at least 30 seconds");
    expect(html).not.toContain("href=");
  });
});

describe("read-only snapshot lifecycle", () => {
  it("reads only the canonical endpoint, coalesces identical reads and never retries", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(ready()));
    vi.stubGlobal("fetch", fetcher);
    const first = acquireSnapshot(id);
    const second = acquireSnapshot(id);
    expect(first.promise).toBe(second.promise);
    expect((await first.promise).status).toBe("loaded");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/api/research/snapshots/${id}`, expect.objectContaining({ cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal) }));
    first.release(); second.release();
  });
  it("does not fetch partial IDs and refuses cross-snapshot responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...ready(), snapshotId: otherId }));
    vi.stubGlobal("fetch", fetcher);
    expect((await acquireSnapshot("partial").promise).status).toBe("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await acquireSnapshot(id).promise).status).toBe("unavailable");
  });
  it.each([404, 410, 429, 500])("handles HTTP %s without retries", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status }));
    vi.stubGlobal("fetch", fetcher);
    expect((await acquireSnapshot(id).promise).status).toBe(status === 410 ? "expired" : "unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects expired, malformed, oversized and inconsistent envelopes", async () => {
    for (const body of [JSON.stringify({ ...ready(), expiresAt: "2020-01-01T00:00:00.000Z" }), "not JSON", " ".repeat(33 * 1024), JSON.stringify({ ...ready(), sources: [] })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      expect((await acquireSnapshot(id).promise).status).not.toBe("loaded");
    }
    expect(evidenceSnapshotSchema.safeParse({ ...ready(), sources: [source, source] }).success).toBe(false);
  });
  it("expires a previously valid response on re-read, with no cached success", async () => {
    vi.useFakeTimers();
    const snapshot = ready();
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(snapshot)));
    vi.stubGlobal("fetch", fetcher);
    expect((await acquireSnapshot(id).promise).status).toBe("loaded");
    vi.setSystemTime(Date.now() + 900_001);
    expect((await acquireSnapshot(id).promise).status).toBe("expired");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("cancels only after the final consumer releases and survives immediate Strict Mode re-subscription", async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const first = acquireSnapshot(id);
    first.release();
    const second = acquireSnapshot(id);
    await Promise.resolve();
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    second.release();
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect((await second.promise).status).toBe("unavailable");
  });
  it("aborts at the five-second deadline even when the transport never settles", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const read = acquireSnapshot(id);
    await vi.advanceTimersByTimeAsync(5000);
    expect((fetcher.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    expect((await read.promise).status).toBe("timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
