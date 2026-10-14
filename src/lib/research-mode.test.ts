import { fetchLLM, openAIConversationMessageFormat, openAIResponsesAdapter } from "@openuidev/react-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localChatStorage } from "./chat-storage";

afterEach(() => vi.unstubAllGlobals());

describe("research mode isolation", () => {
  it("the installed fetchLLM merges researchMode without changing the Responses message transport", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(""));
    const llm = fetchLLM({ url: "/api/chat", streamAdapter: openAIResponsesAdapter(), messageFormat: openAIConversationMessageFormat, body: { researchMode: true }, fetch: fetcher });
    const controller = new AbortController();
    await llm.send({ threadId: "thread-test", signal: controller.signal, messages: [{ id: "message-test", role: "user", content: "Compare publicly documented science activities" }] });
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe("/api/chat");
    const body = JSON.parse(request.body);
    expect(body.researchMode).toBe(true);
    expect(body.tools).toEqual([]);
    expect(body.context).toEqual([]);
    expect(body.messages).toHaveLength(1);
    expect(request.signal).toBe(controller.signal);
  });
  it("preserves ordinary storage keys and isolates create/list/read/delete for research", async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
    const ordinary = localChatStorage();
    const research = localChatStorage("oiu:research");
    const message = { id: "user-message", role: "user" as const, content: "Compare museums" };
    const ordinaryThread = await ordinary.thread.createThread(message);
    const researchThread = await research.thread.createThread(message);
    expect(saved.has("oiu:threads")).toBe(true);
    expect(saved.has("oiu:research:threads")).toBe(true);
    expect(saved.has(`oiu:messages:${ordinaryThread.id}`)).toBe(true);
    expect(saved.has(`oiu:research:messages:${researchThread.id}`)).toBe(true);
    expect((await ordinary.thread.listThreads()).threads.map((thread) => thread.id)).toEqual([ordinaryThread.id]);
    expect((await research.thread.listThreads()).threads.map((thread) => thread.id)).toEqual([researchThread.id]);
    expect(await research.thread.getMessages(ordinaryThread.id)).toEqual([]);
    expect(await ordinary.thread.getMessages(researchThread.id)).toEqual([]);
    await research.thread.deleteThread(researchThread.id);
    expect((await research.thread.listThreads()).threads).toEqual([]);
    expect((await ordinary.thread.getMessages(ordinaryThread.id))).toEqual([message]);
  });
});
