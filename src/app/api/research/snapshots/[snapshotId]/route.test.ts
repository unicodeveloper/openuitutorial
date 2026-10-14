import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { source } from "@/lib/research/test-fixtures";
import { SnapshotStore, SNAPSHOT_TTL_MS } from "@/lib/research/snapshots";

const globals = globalThis as typeof globalThis & { __researchSnapshotStore?: SnapshotStore };
let now: number;
let store: SnapshotStore;
beforeEach(() => {
  vi.resetModules(); now = Date.now(); store = new SnapshotStore(() => now); globals.__researchSnapshotStore = store;
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("snapshot reads must not fetch"); }));
});
afterEach(() => vi.unstubAllGlobals());
async function get(id: string, headers?: HeadersInit, query = "") {
  const { GET } = await import("./route");
  return GET(new Request(`http://localhost/api/research/snapshots/${id}${query}`, { headers }), { params: Promise.resolve({ snapshotId: id }) });
}

describe("read-only same-origin snapshot route", () => {
  it.each(["ready", "empty", "error"] as const)("serves %s snapshots without any provider work", async (status) => {
    const snapshot = store.create(status === "ready" ? { status, partial: false, sources: [source], error: null } :
      status === "empty" ? { status, partial: false, sources: [], error: null } : { status, partial: false, sources: [], error: { code: "not_configured" } });
    const response = await get(snapshot.snapshotId, { Origin: "http://localhost" });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(snapshot);
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["bad", "A".repeat(32), "a".repeat(33)])("rejects invalid identifier %s", async (id) => {
    const response = await get(id); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: "invalid_snapshot_id" } });
  });
  it("distinguishes unknown, expired and unavailable after tombstone loss", async () => {
    expect((await get("0".repeat(32))).status).toBe(404);
    const snapshot = store.create({ status: "empty", sources: [], error: null, partial: false });
    now += SNAPSHOT_TTL_MS;
    const response = await get(snapshot.snapshotId); expect(response.status).toBe(410); expect(await response.json()).toEqual({ error: { code: "snapshot_expired" } });
    now += SNAPSHOT_TTL_MS; expect((await get(snapshot.snapshotId)).status).toBe(404);
  });
  it("rejects cross-origin requests and query parameters", async () => {
    expect((await get("0".repeat(32), { Origin: "https://external.example" })).status).toBe(403);
    expect((await get("0".repeat(32), { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await get("0".repeat(32), {}, "?url=https://example.org")).status).toBe(400);
  });
  it("rejects all mutation/unsupported methods", async () => {
    const route = await import("./route");
    for (const method of [route.POST, route.PUT, route.PATCH, route.DELETE, route.HEAD, route.OPTIONS]) {
      const response = method(); expect(response.status).toBe(405); expect(response.headers.get("Allow")).toBe("GET");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("limits reads locally to sixty/minute", async () => {
    for (let i = 0; i < 60; i++) expect((await get("0".repeat(32))).status).toBe(404);
    expect((await get("0".repeat(32))).status).toBe(429);
  });
});
