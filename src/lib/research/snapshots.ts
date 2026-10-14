import { randomBytes } from "node:crypto";
import { evidenceSnapshotSchema, type EvidenceSnapshot, type SearchOutcome } from "./types";
import { utf8Bytes } from "./transport";
import { safeSourceUrl } from "./valyu";

export const SNAPSHOT_TTL_MS = 15 * 60_000;
export const MAX_SNAPSHOT_BYTES = 32 * 1024;

export class SnapshotStore {
  private live = new Map<string, EvidenceSnapshot>();
  private tombstones = new Map<string, number>();
  private readWindow = 0;
  private reads = 0;
  constructor(private now: () => number = Date.now) {}
  private tombstone(id: string) {
    this.tombstones.set(id, this.now() + SNAPSHOT_TTL_MS);
    while (this.tombstones.size > 100) this.tombstones.delete(this.tombstones.keys().next().value!);
  }
  private prune() {
    const now = this.now();
    for (const [id, snapshot] of this.live) if (Date.parse(snapshot.expiresAt) <= now) {
      this.live.delete(id); this.tombstone(id);
    }
    for (const [id, expires] of this.tombstones) if (expires <= now) this.tombstones.delete(id);
  }
  create(outcome: SearchOutcome): EvidenceSnapshot {
    this.prune();
    const now = this.now();
    const snapshot = evidenceSnapshotSchema.parse({ version: 1, snapshotId: randomBytes(16).toString("hex"),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SNAPSHOT_TTL_MS).toISOString(), ...outcome }) as EvidenceSnapshot;
    if (snapshot.sources.some((s) => safeSourceUrl(s.url) !== s.url)) throw new Error("invalid source URL");
    if (utf8Bytes(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) throw new Error("snapshot too large");
    for (const source of snapshot.sources) Object.freeze(source);
    Object.freeze(snapshot.sources);
    if (snapshot.error) Object.freeze(snapshot.error);
    Object.freeze(snapshot);
    while (this.live.size >= 50) {
      const oldest = this.live.keys().next().value!; this.live.delete(oldest); this.tombstone(oldest);
    }
    this.live.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }
  read(id: string): EvidenceSnapshot | "expired" | "unavailable" {
    this.prune();
    return this.live.get(id) ?? (this.tombstones.has(id) ? "expired" : "unavailable");
  }
  admitRead() {
    const window = Math.floor(this.now() / 60_000);
    if (window !== this.readWindow) { this.readWindow = window; this.reads = 0; }
    return ++this.reads <= 60;
  }
}
const shared = globalThis as typeof globalThis & { __researchSnapshotStore?: SnapshotStore };
export const snapshotStore = shared.__researchSnapshotStore ??= new SnapshotStore();
