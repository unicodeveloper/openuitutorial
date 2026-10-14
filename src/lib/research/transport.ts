export const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export class BodyLimitError extends Error {}

/** Counts actual streamed bytes; Content-Length is only an early rejection. */
export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, max: number, signal?: AbortSignal): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new BodyLimitError("body too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function deadline(parent: AbortSignal, milliseconds: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
  return {
    signal: controller.signal,
    abort,
    timedOut: () => timedOut,
    dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", abort); },
  };
}
