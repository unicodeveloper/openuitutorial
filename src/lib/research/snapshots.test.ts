import { describe, expect, it } from "vitest";
import { SnapshotStore, SNAPSHOT_TTL_MS } from "./snapshots";
import { source } from "./test-fixtures";

describe("single-process immutable snapshot store", () => {
  it("validates states, canonical IDs, safe URLs and freezes a detached snapshot", () => {
    const store = new SnapshotStore(); const input = structuredClone(source);
    const snapshot = store.create({ status: "ready", partial: false, sources: [input], error: null });
    input.excerpt = "changed";
    expect(snapshot.snapshotId).toMatch(/^[a-f0-9]{32}$/);
    expect(snapshot.sources[0].excerpt).toBe(source.excerpt);
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.sources[0])).toBe(true);
    expect(() => store.create({ status: "ready", sources: [], error: null, partial: false })).toThrow();
    expect(() => store.create({ status: "ready", sources: [{ ...source, id: "s2" }], error: null, partial: false })).toThrow();
    expect(() => store.create({ status: "ready", sources: [{ ...source, url: "https://localhost/" }], error: null, partial: false })).toThrow();
  });
  it("distinguishes expiry from unavailable until bounded tombstones expire", () => {
    let now = Date.now(); const store = new SnapshotStore(() => now);
    const snapshot = store.create({ status: "empty", sources: [], partial: false, error: null });
    expect(store.read(snapshot.snapshotId)).toEqual(snapshot);
    now += SNAPSHOT_TTL_MS;
    expect(store.read(snapshot.snapshotId)).toBe("expired");
    now += SNAPSHOT_TTL_MS;
    expect(store.read(snapshot.snapshotId)).toBe("unavailable");
    expect(new SnapshotStore().read(snapshot.snapshotId)).toBe("unavailable");
  });
  it("evicts oldest beyond fifty and retains only one hundred tombstones", () => {
    const store = new SnapshotStore();
    const entries = Array.from({ length: 151 }, () => store.create({ status: "empty", sources: [], partial: false, error: null }));
    expect(store.read(entries[0].snapshotId)).toBe("unavailable");
    expect(store.read(entries[1].snapshotId)).toBe("expired");
    expect(store.read(entries[101].snapshotId)).toEqual(entries[101]);
  });
  it("keeps repeated s1 IDs scoped to snapshots", () => {
    const store = new SnapshotStore();
    const a = store.create({ status: "ready", sources: [source], partial: false, error: null });
    const b = store.create({ status: "ready", sources: [{ ...source, excerpt: "Different evidence" }], partial: false, error: null });
    expect(a.snapshotId).not.toBe(b.snapshotId);
    expect(store.read(a.snapshotId)).toEqual(a); expect(store.read(b.snapshotId)).toEqual(b);
  });
  it("admits sixty reads per minute process-wide", () => {
    let now = 0; const store = new SnapshotStore(() => now);
    expect(Array.from({ length: 60 }, () => store.admitRead()).every(Boolean)).toBe(true);
    expect(store.admitRead()).toBe(false); now += 60_000; expect(store.admitRead()).toBe(true);
  });
});
