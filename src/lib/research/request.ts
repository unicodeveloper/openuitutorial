import { z } from "zod/v4";
import { codepoints } from "./types";
import { querySchema } from "./valyu";

const textPart = z.strictObject({ type: z.enum(["text", "input_text", "output_text"]), text: z.string() });
const messageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.union([z.string(), z.array(textPart).min(1).max(20)]) });
const requestSchema = z.strictObject({
  researchMode: z.literal(true), messages: z.array(messageSchema).min(1).max(60),
  threadId: z.string().max(200).optional(), runId: z.string().max(200).optional(),
  tools: z.array(z.never()).max(0).optional(), context: z.array(z.never()).max(0).optional(),
});

export function parseResearchRequest(value: unknown) {
  const request = requestSchema.safeParse(value);
  if (!request.success) return null;
  const messages = request.data.messages.map((m) => ({ role: m.role,
    content: typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("") }));
  const latest = messages.at(-1)!;
  if (latest.role !== "user") return null;
  const query = querySchema.safeParse(latest.content);
  if (!query.success) return null;
  const history = messages.slice(0, -1).filter((m) => codepoints(m.content) <= 1000).slice(-6);
  return { query: query.data, input: [...history, { role: "user" as const, content: query.data }] };
}
