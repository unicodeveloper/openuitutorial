import { snapshotStore } from "@/lib/research/snapshots";
import { snapshotIdSchema } from "@/lib/research/types";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const error = (code: string, status: number) => Response.json({ error: { code } }, { status, headers });

export async function GET(req: Request, context: { params: Promise<{ snapshotId: string }> }) {
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site") return error("snapshot_unavailable", 403);
  if (new URL(req.url).search) return error("invalid_snapshot_id", 400);
  const id = snapshotIdSchema.safeParse((await context.params).snapshotId);
  if (!id.success) return error("invalid_snapshot_id", 400);
  if (!snapshotStore.admitRead()) return error("rate_limited", 429);
  const result = snapshotStore.read(id.data);
  if (result === "expired") return error("snapshot_expired", 410);
  if (result === "unavailable") return error("snapshot_unavailable", 404);
  return Response.json(result, { headers });
}

const unsupported = () => Response.json({ error: { code: "method_not_allowed" } }, { status: 405, headers: { ...headers, Allow: "GET" } });
export const POST = unsupported;
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
export const HEAD = unsupported;
export const OPTIONS = unsupported;
