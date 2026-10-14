import { z } from "zod/v4";

export type SourceId = "s1" | "s2" | "s3";
export type ResearchErrorCode = "not_configured" | "unavailable" | "rate_limited" | "timeout" | "invalid_upstream" | "upstream_error" | "budget_exceeded";
export type EvidenceSource = {
  id: SourceId; title: string; url: string; source: string; excerpt: string;
  publicationDate: string | null; retrievedAt: string; relevanceScore: number | null;
};
type SnapshotBase = {
  version: 1; snapshotId: string; createdAt: string; expiresAt: string; partial: boolean;
};
export type EvidenceSnapshot = SnapshotBase & (
  | { status: "ready"; sources: EvidenceSource[]; error: null }
  | { status: "empty"; sources: []; error: null }
  | { status: "error"; sources: []; error: { code: ResearchErrorCode; retryAfterSeconds?: number } }
);
export type SearchOutcome = Pick<EvidenceSnapshot, "status" | "partial" | "sources" | "error">;

export const snapshotIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const codepoints = (value: string) => Array.from(value).length;
// Match the existing UI Zod string bounds (UTF-16 units); query limits use code points separately.
export const boundedText = (max: number) => z.string().max(max).refine((s) => s.trim().length > 0);
export const sourceIdSchema = z.enum(["s1", "s2", "s3"]);
const sourceSchema = z.strictObject({
  id: sourceIdSchema, title: boundedText(200), url: boundedText(2048), source: boundedText(100), excerpt: boundedText(1500),
  publicationDate: z.iso.datetime().nullable(), retrievedAt: z.iso.datetime(), relevanceScore: z.number().finite().min(0).max(1).nullable(),
});
const snapshotBase = { version: z.literal(1), snapshotId: snapshotIdSchema, createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), partial: z.boolean() };
export const evidenceSnapshotSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...snapshotBase, status: z.literal("ready"), sources: z.array(sourceSchema).min(1).max(3), error: z.null() }),
  z.strictObject({ ...snapshotBase, status: z.literal("empty"), sources: z.array(z.never()).max(0), error: z.null() }),
  z.strictObject({ ...snapshotBase, status: z.literal("error"), partial: z.literal(false), sources: z.array(z.never()).max(0), error: z.strictObject({
    code: z.enum(["not_configured", "unavailable", "rate_limited", "timeout", "invalid_upstream", "upstream_error", "budget_exceeded"]),
    retryAfterSeconds: z.number().int().min(1).max(3600).optional(),
  }) }),
]).refine((s) => s.sources.every((source, i) => source.id === `s${i + 1}`));
export const researchOptionsSchema = z.array(z.strictObject({
  id: z.string().regex(/^c[1-3]$/),
  label: boundedText(100),
  claims: z.array(z.strictObject({
    criterion: boundedText(100),
    statement: boundedText(300),
    sourceIds: z.array(sourceIdSchema).min(1).max(3).refine((ids) => new Set(ids).size === ids.length),
    evidenceStatus: z.enum(["supported", "uncertain"]),
  })).min(1).max(3),
})).max(3).refine((options) => new Set(options.map((o) => o.id)).size === options.length);

/** Structural membership is not proof that an excerpt entails a claim. */
export function hasCanonicalSources(options: unknown, snapshot: EvidenceSnapshot): boolean {
  const parsed = researchOptionsSchema.safeParse(options);
  if (!parsed.success || snapshot.status !== "ready" || !parsed.data.length) return false;
  const ids = new Set(snapshot.sources.map((s) => s.id));
  return parsed.data.every((o) => o.claims.every((c) => c.sourceIds.every((id) => ids.has(id))));
}
