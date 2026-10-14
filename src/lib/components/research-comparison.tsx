"use client";

import { defineComponent, reactive, useIsStreaming, useStateField } from "@openuidev/react-lang";
import { useEffect, useId, useState } from "react";
import { z } from "zod/v4";
import type { EvidenceSnapshot, EvidenceSource, ResearchErrorCode } from "../research/types";

export const snapshotIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const sourceIdSchema = z.enum(["s1", "s2", "s3"]);
const distinct = (ids: string[]) => new Set(ids).size === ids.length;
const text = (max: number) => z.string().trim().min(1).max(max);

export const researchClaimSchema = z.strictObject({
  criterion: text(100),
  statement: text(300),
  sourceIds: z.array(sourceIdSchema).min(1).max(3).refine(distinct, "Source IDs must be distinct"),
  evidenceStatus: z.enum(["supported", "uncertain"]),
});

export const researchOptionsSchema = z.array(z.strictObject({
  id: z.enum(["c1", "c2", "c3"]),
  label: text(100),
  claims: z.array(researchClaimSchema).min(1).max(3),
})).max(3).refine((options) => distinct(options.map((option) => option.id)), "Option IDs must be distinct");
export type ResearchOption = z.infer<typeof researchOptionsSchema>[number];

const sourceSchema = z.strictObject({
  id: sourceIdSchema,
  title: text(200),
  url: z.string().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch { return false; }
  }),
  source: text(100),
  excerpt: text(1500),
  publicationDate: z.string().nullable(),
  retrievedAt: z.iso.datetime(),
  relevanceScore: z.number().min(0).max(1).nullable(),
});
const errorCodeSchema = z.enum([
  "not_configured", "unavailable", "rate_limited", "timeout", "invalid_upstream", "upstream_error", "budget_exceeded",
]);
const snapshotBase = {
  version: z.literal(1),
  snapshotId: snapshotIdSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  partial: z.boolean(),
};
export const evidenceSnapshotSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...snapshotBase, status: z.literal("ready"), sources: z.array(sourceSchema).min(1).max(3), error: z.null() }),
  z.strictObject({ ...snapshotBase, status: z.literal("empty"), sources: z.tuple([]), error: z.null() }),
  z.strictObject({ ...snapshotBase, status: z.literal("error"), sources: z.tuple([]), error: z.strictObject({ code: errorCodeSchema, retryAfterSeconds: z.number().int().min(1).max(3600).optional() }) }),
]).refine((snapshot) => {
  if (!distinct(snapshot.sources.map((source) => source.id))) return false;
  if (Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.createdAt)) return false;
  if (snapshot.status === "ready") return snapshot.sources.length > 0 && snapshot.error === null;
  return snapshot.sources.length === 0 && (snapshot.status === "error" ? snapshot.error !== null : snapshot.error === null);
});

export type SnapshotRead =
  | { status: "loading" | "unavailable" | "expired" | "timeout" }
  | { status: "loaded"; snapshot: EvidenceSnapshot };

const pendingReads = new Map<string, { promise: Promise<SnapshotRead>; controller: AbortController; readers: number }>();

async function fetchSnapshot(id: string, signal: AbortSignal): Promise<SnapshotRead> {
  const response = await fetch(`/api/research/snapshots/${id}`, { signal, cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" });
  if (response.status === 410) return { status: "expired" };
  if (!response.ok || !response.body) return { status: "unavailable" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32 * 1024) {
        await reader.cancel();
        return { status: "unavailable" };
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  const parsed = evidenceSnapshotSchema.safeParse(JSON.parse(body));
  if (!parsed.success || parsed.data.snapshotId !== id) return { status: "unavailable" };
  if (Date.parse(parsed.data.expiresAt) <= Date.now()) return { status: "expired" };
  return { status: "loaded", snapshot: parsed.data };
}

/** Coalesce concurrent reads; never retry or retrieve fresh evidence on interaction. */
export function acquireSnapshot(id: string): { promise: Promise<SnapshotRead>; release: () => void } {
  if (!snapshotIdSchema.safeParse(id).success) return { promise: Promise.resolve({ status: "unavailable" }), release() {} };
  let entry = pendingReads.get(id);
  if (!entry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("deadline"), 5000);
    const aborted = new Promise<SnapshotRead>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve({ status: controller.signal.reason === "deadline" ? "timeout" : "unavailable" }), { once: true });
    });
    const promise = Promise.race([fetchSnapshot(id, controller.signal), aborted])
      .catch((): SnapshotRead => ({ status: "unavailable" }))
      .finally(() => {
        clearTimeout(timer);
        if (pendingReads.get(id)?.controller === controller) pendingReads.delete(id);
      });
    entry = { promise, controller, readers: 0 };
    pendingReads.set(id, entry);
  }
  const current = entry;
  current.readers += 1;
  let released = false;
  return {
    promise: current.promise,
    release() {
      if (released) return;
      released = true;
      current.readers -= 1;
      // Strict Mode can subscribe again before this microtask runs.
      queueMicrotask(() => {
        if (current.readers === 0) {
          if (pendingReads.get(id) === current) pendingReads.delete(id);
          current.controller.abort("unmounted");
        }
      });
    },
  };
}

function useEvidenceSnapshot(id: string): SnapshotRead {
  const [read, setRead] = useState<{ id: string; result: SnapshotRead } | null>(null);
  useEffect(() => {
    if (!snapshotIdSchema.safeParse(id).success) return;
    let active = true;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const subscription = acquireSnapshot(id);
    void subscription.promise.then((result) => {
      if (!active) return;
      setRead({ id, result });
      if (result.status === "loaded") {
        expiry = setTimeout(() => setRead({ id, result: { status: "expired" } }),
          Math.max(0, Math.min(Date.parse(result.snapshot.expiresAt) - Date.now(), 2_147_483_647)));
      }
    });
    return () => { active = false; clearTimeout(expiry); subscription.release(); };
  }, [id]);
  if (!snapshotIdSchema.safeParse(id).success) return { status: "loading" };
  const result = read?.id === id ? read.result : { status: "loading" as const };
  // Also recheck on render after a suspended/backgrounded tab resumes.
  return result.status === "loaded" && Date.parse(result.snapshot.expiresAt) <= Date.now() ? { status: "expired" } : result;
}

export function validSelection(value: unknown, options: ResearchOption[]): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(options.map((option) => option.id));
  return [...new Set(value.filter((id): id is string => typeof id === "string" && allowed.has(id as ResearchOption["id"])))].slice(0, 3);
}

export function toggleSelection(selected: string[], id: string, options: ResearchOption[]): string[] {
  return validSelection(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id], options);
}

export function resolveClaim(claim: ResearchOption["claims"][number], sources: EvidenceSource[]) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const known = claim.sourceIds.every((id) => byId.has(id));
  return {
    status: !known ? "unsupported" as const : claim.evidenceStatus,
    sources: known ? claim.sourceIds.flatMap((id) => byId.get(id) ?? []) : [],
  };
}

const errorCopy: Record<ResearchErrorCode, string> = {
  not_configured: "Research is not configured here yet.",
  unavailable: "Research is unavailable right now.",
  rate_limited: "Research is busy right now. Please wait before sending a new question.",
  timeout: "The evidence search took too long.",
  invalid_upstream: "The returned evidence could not be used.",
  upstream_error: "The evidence search could not be completed.",
  budget_exceeded: "The research limit for this demo has been reached.",
};

function SourceExcerpt({ source }: { source: EvidenceSource }) {
  return (
    <details className="research-source">
      <summary><span className="research-source-id">{source.id}</span><span>{source.title}</span><span className="research-source-hint">Excerpt</span></summary>
      <div className="research-source-body">
        <blockquote>{source.excerpt}</blockquote>
        <a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open source <span aria-hidden="true">↗</span><span className="research-sr-only">: {source.title}</span></a>
        <p>{source.source} · Retrieved {new Date(source.retrievedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
        {source.publicationDate ? <p>Publication date: {source.publicationDate}</p> : null}
      </div>
    </details>
  );
}

export function ResearchComparisonView({ options, selectedIds, onSelect, read, streaming = false, invalid = false, title }: {
  options: ResearchOption[];
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  read: SnapshotRead;
  streaming?: boolean;
  invalid?: boolean;
  title?: string;
}) {
  const headingId = useId();
  const [selectedOnly, setSelectedOnly] = useState(false);
  const snapshot = read.status === "loaded" ? read.snapshot : null;
  const ready = snapshot?.status === "ready";
  const eligible = ready ? options.filter((option) => option.claims.every((claim) => resolveClaim(claim, snapshot.sources).status !== "unsupported")) : [];
  const selected = validSelection(selectedIds, eligible);
  let message: string | null = null;
  if (read.status === "loading") message = "Loading source evidence…";
  else if (read.status === "expired" || read.status === "unavailable") message = "This evidence snapshot has expired or is unavailable. Send a new research question to try again.";
  else if (read.status === "timeout") message = "Source evidence took too long to load. Send a new question when you’re ready.";
  else if (snapshot?.status === "empty") message = "No usable sources were returned for this question.";
  else if (snapshot?.status === "error") message = errorCopy[snapshot.error!.code];
  else if (invalid && !streaming) message = "This comparison is incomplete or contains unsupported option data. Send a new question to try again.";
  else if (!options.length && !streaming) message = "The evidence is available, but no comparison options were returned.";
  const canShowOptions = ready && !message;
  const visible = selectedOnly ? options.filter((option) => selected.includes(option.id)) : options;
  const usedSources = new Map<string, EvidenceSource>();
  if (canShowOptions) for (const option of visible) for (const claim of option.claims) {
    for (const source of resolveClaim(claim, snapshot.sources).sources) usedSources.set(source.id, source);
  }
  return (
    <section className="research-comparison" aria-labelledby={headingId} aria-busy={streaming || read.status === "loading"}>
      <header className="research-heading">
        <p className="research-eyebrow">A closer look</p>
        <h2 id={headingId}>{title || "Compare your options"}</h2>
        <p>Explore the evidence. Keep the options that work for you.</p>
      </header>
      {message ? <p className="research-state" role="status">{message}{snapshot?.error?.code === "rate_limited" && snapshot.error.retryAfterSeconds ? ` Wait at least ${snapshot.error.retryAfterSeconds} seconds.` : ""}</p> : null}
      {canShowOptions ? <>
        {snapshot.partial ? <p className="research-note">Some sources were unavailable; this comparison uses the evidence returned.</p> : null}
        <div className="research-toolbar">
          <span role="status" aria-live="polite">{selected.length ? `${selected.length} of ${options.length} shortlisted` : "Choose a shortlist"}</span>
          <label><input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} />Shortlist only</label>
        </div>
        <div className="research-options">
          {visible.map((option) => <article key={option.id} className={`research-option${selected.includes(option.id) ? " is-selected" : ""}`}>
            <div className="research-option-top"><h3>{option.label}</h3><span className="research-option-number" aria-hidden="true">{option.id.slice(1).padStart(2, "0")}</span></div>
            <dl className="research-claims">{option.claims.map((claim, index) => {
              const evidence = resolveClaim(claim, snapshot.sources);
              return <div key={index}>
                <dt>{claim.criterion}</dt>
                <dd>{evidence.status === "unsupported" ? "This claim is not supported by the available source evidence." : claim.statement}</dd>
                <dd className="research-claim-evidence">{evidence.status === "uncertain" ? <span>Uncertain · check the source</span> : null}{evidence.status === "unsupported" ? <span>Unsupported evidence</span> : null}
                  {evidence.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Source ${source.id}: ${source.title}`}>{source.id}<span aria-hidden="true"> ↗</span></a>)}
                </dd>
              </div>;
            })}</dl>
            <label className="research-shortlist"><input type="checkbox" checked={selected.includes(option.id)} disabled={streaming || !eligible.includes(option)} onChange={() => { if (!streaming) onSelect(toggleSelection(selected, option.id, eligible)); }} /><span>{!eligible.includes(option) ? "Evidence unavailable" : selected.includes(option.id) ? "Shortlisted" : "Add to shortlist"}<span className="research-sr-only">: {option.label}</span></span></label>
          </article>)}
        </div>
        {selectedOnly && !visible.length ? <div className="research-state"><p>Select an option to build your shortlist.</p><button type="button" onClick={() => setSelectedOnly(false)}>Show all options</button></div> : null}
        {usedSources.size ? <section className="research-evidence" aria-label="Source excerpts"><h3>Behind the comparison <span>{usedSources.size} {usedSources.size === 1 ? "source" : "sources"}</span></h3>{[...usedSources.values()].map((source) => <SourceExcerpt key={source.id} source={source} />)}</section> : null}
        <p className="research-footnote">{streaming ? "The comparison is still coming together…" : "Shortlisting and opening excerpts update this answer locally."} Sources can change; a citation is an invitation to check.</p>
      </> : null}
    </section>
  );
}

export const ResearchComparison = defineComponent({
  name: "ResearchComparison",
  description: "Compare up to three evidence-backed options from one existing server snapshot. Reads evidence once; shortlist and excerpt controls are local. Never searches. Use a reactive $selectedIds array. Claims distinguish supported and uncertain evidence; unmatched source IDs appear unsupported. No URLs or actions in props.",
  props: z.object({
    snapshotId: snapshotIdSchema,
    options: researchOptionsSchema,
    selectedIds: reactive(z.array(z.string()).max(3)),
    title: text(200).optional(),
  }),
  component: function ResearchComparisonRenderer({ props, statementId }) {
    const fallbackId = useId();
    const field = useStateField(statementId ?? fallbackId, props.selectedIds);
    const streaming = useIsStreaming();
    const id = typeof props.snapshotId === "string" ? props.snapshotId : "";
    const read = useEvidenceSnapshot(id);
    const parsed = researchOptionsSchema.safeParse(props.options);
    const options = parsed.success ? parsed.data : [];
    const title = text(200).safeParse(props.title);
    const invalidId = !snapshotIdSchema.safeParse(id).success;
    return <ResearchComparisonView key={id} options={options} selectedIds={validSelection(field.value, options)}
      onSelect={(ids) => {
        if (!streaming && read.status === "loaded" && read.snapshot.status === "ready" && Date.parse(read.snapshot.expiresAt) > Date.now()) {
          const eligible = options.filter((option) => option.claims.every((claim) => resolveClaim(claim, read.snapshot.sources).status !== "unsupported"));
          field.setValue(validSelection(ids, eligible));
        }
      }}
      read={invalidId && !streaming ? { status: "unavailable" } : read} streaming={streaming} invalid={!parsed.success}
      title={title.success ? title.data : undefined} />;
  },
});
