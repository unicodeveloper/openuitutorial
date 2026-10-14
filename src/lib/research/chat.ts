import researchSpec from "@/generated/research-library-spec.json";
import type { LibrarySpec } from "@openuidev/lang-core";
import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import { comparisonProgram, evidenceMessage, researchInstructions, validateResearchProgram } from "./prompt";
import { parseResearchRequest } from "./request";
import { snapshotStore } from "./snapshots";
import { searchValyu } from "./valyu";
import { deadline, utf8Bytes } from "./transport";
import type { ResearchErrorCode } from "./types";

type ResearchBackend = { kind: "cloud" | "direct"; model: string; missingConfig?: string; connect: () => OpenAI };
const library: LibrarySpec = researchSpec;

/** Matches the existing Responses adapter's wire format for validated/canned text. */
export function researchSSE(program: string): Response {
  const id = "research_message";
  const events = [
    { type: "response.output_item.added", item: { id, type: "message", role: "assistant", content: [], status: "in_progress" }, output_index: 0 },
    { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: program },
    { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text: program },
    { type: "response.completed" },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "Referrer-Policy": "no-referrer" },
  });
}

export async function researchChat(req: Request, value: unknown, backend: ResearchBackend, effort?: ReasoningEffort): Promise<Response> {
  const request = parseResearchRequest(value);
  if (!request) return Response.json({ error: { message: "invalid research request" } }, { status: 400 });
  const cancelled = () => new Response(null, { status: 499 });
  if (req.signal.aborted) return cancelled();
  const unavailable = (code: ResearchErrorCode = "unavailable") => {
    const snapshot = snapshotStore.create({ status: "error", sources: [], partial: false, error: { code } });
    return researchSSE(comparisonProgram(snapshot.snapshotId, [], "Research unavailable"));
  };
  if (backend.missingConfig) return unavailable();
  let instructions: string;
  try { instructions = researchInstructions(library, backend.kind === "cloud"); }
  catch { return unavailable(); }
  let snapshot;
  try {
    const outcome = await searchValyu(request.query, req.signal);
    req.signal.throwIfAborted();
    snapshot = snapshotStore.create(outcome);
  } catch { return req.signal.aborted ? cancelled() : unavailable(); }
  if (snapshot.status !== "ready") return researchSSE(comparisonProgram(snapshot.snapshotId, [], "Research evidence"));
  const bound = deadline(req.signal, 60_000);
  try {
    const input = [...request.input, { role: "user" as const, content: evidenceMessage(snapshot) }];
    const client = backend.connect();
    const options = { signal: bound.signal, maxRetries: 0 };
    let text = "";
    let completed = false;
    const append = (delta: string) => {
      bound.signal.throwIfAborted();
      text += delta;
      if (utf8Bytes(text) > 32 * 1024) { bound.abort(); throw new Error("output too large"); }
    };
    if (backend.kind === "cloud") {
      const stream = await client.responses.create({ model: backend.model, instructions, input, store: false,
        max_output_tokens: 2000, stream: true, ...(effort ? { reasoning: { effort } } : {}) }, options);
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") append(event.delta);
        else if (event.type === "response.completed") completed = true;
        else if (event.type === "response.output_item.added" && event.item.type !== "message" && event.item.type !== "reasoning") throw new Error("unsupported generation");
        else if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") throw new Error("generation failed");
      }
    } else {
      const stream = await client.chat.completions.create({ model: backend.model,
        messages: [{ role: "system", content: instructions }, ...input], stream: true, max_completion_tokens: 2000,
        ...(effort ? { reasoning_effort: effort, reasoning: { effort } } : {}) }, options);
      for await (const chunk of stream) {
        if (chunk.choices.some((choice) => choice.delta.tool_calls?.length || choice.finish_reason === "length" || choice.finish_reason === "content_filter")) throw new Error("unsupported generation");
        append(chunk.choices[0]?.delta.content ?? "");
        if (chunk.choices[0]?.finish_reason === "stop") completed = true;
      }
    }
    bound.signal.throwIfAborted();
    if (!completed) return unavailable("invalid_upstream");
    // Hold research output until bounded syntax, snapshot and citation membership are checked.
    const program = validateResearchProgram(text, snapshot, library);
    if (!program) return unavailable("invalid_upstream");
    return researchSSE(program);
  } catch { return req.signal.aborted ? cancelled() : unavailable(bound.timedOut() ? "timeout" : "unavailable"); }
  finally { bound.abort(); bound.dispose(); }
}
