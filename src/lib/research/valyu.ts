import { isIP } from "node:net";
import { z } from "zod/v4";
import { codepoints, type EvidenceSource, type ResearchErrorCode, type SearchOutcome, type SourceId } from "./types";
import { BodyLimitError, deadline, readBoundedBody } from "./transport";

export const VALYU_ENDPOINT = "https://api.valyu.ai/v1/search";
export const SEARCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REPORTED_COST = 0.02;
const MAX_ADMISSIONS = 50;
const finiteNonnegative = z.number().finite().nonnegative();
const envelopeSchema = z.object({
  success: z.boolean(), tx_id: z.string(), query: z.string(), results: z.array(z.unknown()),
  results_by_source: z.record(z.string(), z.unknown()), total_deduction_dollars: finiteNonnegative,
  total_characters: finiteNonnegative, error: z.string().nullable().optional(), warnings: z.array(z.string()).optional(),
});
const resultSchema = z.object({
  id: z.string(), title: z.string(), url: z.string(), content: z.string(), source: z.literal("web"),
  price: finiteNonnegative, length: finiteNonnegative, data_type: z.literal("unstructured"), source_type: z.enum(["website", "forum"]),
  relevance_score: z.number().finite().min(0).max(1).optional(), publication_date: z.string().optional(),
});
const authSchema = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
export const querySchema = z.string().transform((s) => s.trim()).refine((s) => codepoints(s) >= 1 && codepoints(s) <= 400);

export function searchPayload(query: string) {
  return { query: querySchema.parse(query), search_type: "web", max_num_results: 3, response_length: 1500,
    max_price: 4.5, relevance_threshold: 0.5, is_tool_call: true, fast_mode: false };
}

/** Display-only URLs. No DNS resolution, navigation or source fetch occurs here. */
export function safeSourceUrl(raw: string): string | null {
  if (codepoints(raw) > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") || host.startsWith("[") || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) return null;
    if (isIP(host) === 4) {
      const [a, b] = host.split(".").map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
        (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return null;
    }
    return codepoints(url.href) <= 2048 ? url.href : null;
  } catch { return null; }
}

function clip(s: string, max: number) {
  let text = "";
  for (const character of s) {
    if (text.length + character.length > max) break;
    text += character;
  }
  return text;
}
function plainText(text: string, max: number) {
  return clip(text.replace(/<[^>]*>/g, " ").replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/[`*_#>~]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim(), max);
}

export function normalizeResults(results: unknown[], retrievedAt: string) {
  const sources: EvidenceSource[] = [];
  const seen = new Set<string>();
  let partial = results.length > 20;
  for (const raw of results.slice(0, 20)) {
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) { partial = true; continue; }
    const r = parsed.data;
    const url = safeSourceUrl(r.url);
    const title = plainText(r.title, 200);
    const excerpt = plainText(r.content, 1500);
    const source = plainText(r.source, 100);
    if (!url || !title || !excerpt || !source) { partial = true; continue; }
    const key = new URL(url); key.hash = "";
    if (seen.has(key.href)) { partial = true; continue; }
    seen.add(key.href);
    if (sources.length === 3) { partial = true; continue; }
    const date = r.publication_date;
    const publicationDate = date && z.union([z.iso.date(), z.iso.datetime({ offset: true })]).safeParse(date).success && Number.isFinite(Date.parse(date))
      ? new Date(date).toISOString() : null;
    sources.push({ id: `s${sources.length + 1}` as SourceId, title, url, source, excerpt, publicationDate,
      retrievedAt, relevanceScore: r.relevance_score ?? null });
  }
  return { sources, partial };
}

export type SearchAdmissionState = { inFlight: boolean; admitted: number; disabled: boolean; reservedDollars: number; reportedDollars: number };
export const newSearchAdmissionState = (): SearchAdmissionState => ({ inFlight: false, admitted: 0, disabled: false, reservedDollars: 0, reportedDollars: 0 });
const globalState = globalThis as typeof globalThis & { __researchSearchAdmission?: SearchAdmissionState };
function admissionState() { return globalState.__researchSearchAdmission ??= newSearchAdmissionState(); }
const errorOutcome = (code: ResearchErrorCode, retryAfterSeconds?: number): SearchOutcome => ({
  status: "error", partial: false, sources: [], error: { code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
});
const TRANSPORT_CODES = new Set([
  "ENOTFOUND", "ENODATA", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_ENCODING_INVALID_ENCODED_DATA",
]);
function transportCause(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown";
  const error = err as { code?: unknown; cause?: { code?: unknown } };
  for (const code of [error.code, error.cause?.code]) {
    if (typeof code === "string" && TRANSPORT_CODES.has(code)) return code;
  }
  return "unknown";
}

export async function searchValyu(query: string, signal: AbortSignal, options: {
  fetch?: typeof fetch; enabled?: boolean; apiKey?: string; state?: SearchAdmissionState; now?: () => number;
} = {}): Promise<SearchOutcome> {
  const payload = searchPayload(query);
  signal.throwIfAborted();
  const enabled = options.enabled ?? process.env.VALYU_RESEARCH_ENABLED === "true";
  const key = authSchema.safeParse(options.apiKey ?? process.env.VALYU_API_KEY);
  if (!enabled || !key.success) return errorOutcome("not_configured");
  const state = options.state ?? admissionState();
  if (state.disabled || state.admitted >= MAX_ADMISSIONS) return errorOutcome("budget_exceeded");
  if (state.inFlight) return errorOutcome("rate_limited");
  state.inFlight = true; state.admitted++; state.reservedDollars += MAX_REPORTED_COST;
  const bound = deadline(signal, SEARCH_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)(VALYU_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key.data },
      body: JSON.stringify(payload), signal: bound.signal, redirect: "error", cache: "no-store",
    });
    bound.signal.throwIfAborted();
    if (response.status !== 200 && response.status !== 206) {
      console.warn({ provider: "valyu", phase: "http", status: response.status });
      await response.body?.cancel();
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const seconds = retry && /^\d+$/.test(retry) ? Math.min(3600, Math.max(1, Number(retry))) : undefined;
        return errorOutcome("rate_limited", seconds);
      }
      return errorOutcome([401, 402, 403].includes(response.status) ? "unavailable" : "upstream_error");
    }
    const body = await readBoundedBody(response.body, MAX_RESPONSE_BYTES, bound.signal);
    let json: unknown;
    try { json = JSON.parse(body); } catch { state.disabled = true; return errorOutcome("invalid_upstream"); }
    const cost = z.object({ total_deduction_dollars: finiteNonnegative }).safeParse(json);
    if (!cost.success) { state.disabled = true; return errorOutcome("invalid_upstream"); }
    state.reportedDollars += cost.data.total_deduction_dollars;
    // This acceptance guard cannot undo charges. max_price's CPM unit is ambiguous.
    if (cost.data.total_deduction_dollars > MAX_REPORTED_COST) { state.disabled = true; return errorOutcome("budget_exceeded"); }
    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) return errorOutcome("invalid_upstream");
    if (!parsed.data.success) return errorOutcome("upstream_error");
    const normalized = normalizeResults(parsed.data.results, new Date((options.now ?? Date.now)()).toISOString());
    return { status: normalized.sources.length ? "ready" : "empty", sources: normalized.sources, error: null,
      partial: normalized.partial || response.status === 206 || !!parsed.data.error || !!parsed.data.warnings?.length };
  } catch (err) {
    if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    console.warn({ provider: "valyu", phase: "fetch_or_read", cause: bound.timedOut() ? "timeout" : err instanceof BodyLimitError ? "body_limit" : transportCause(err) });
    if (bound.timedOut()) return errorOutcome("timeout");
    // Unaccountable body/transport failures keep their reservation; stop after body violations.
    if (err instanceof BodyLimitError || err instanceof TypeError && /encoded data/.test(err.message)) {
      state.disabled = true;
      return errorOutcome("invalid_upstream");
    }
    return errorOutcome("upstream_error");
  } finally { bound.abort(); bound.dispose(); state.inFlight = false; }
}
