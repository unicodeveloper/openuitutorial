import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "ordinary", setMode: vi.fn(), messages: [{ id: "answer", role: "assistant", content: "fixture", state: { selectedIds: ["c2"] } }], writes: new Map<string, string>() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: () => [state.mode, state.setMode],
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("@openuidev/react-ui", async (original) => {
  const actual = await original<typeof import("@openuidev/react-ui")>();
  const AgentInterface = Object.assign(() => null, { Welcome: () => null });
  return { ...actual, AgentInterface,
    useThread: (selector: (value: unknown) => unknown) => selector({ messages: state.messages, isRunning: false }),
    useThreadList: (selector: (value: unknown) => unknown) => selector({ selectedThreadId: "thread-test" }),
  };
});
import { AgentInterface } from "@openuidev/react-ui";
import Home from "../app/page";
import { SaveMessages } from "./chat-storage";
import { library } from "./library";
import { researchLibrary } from "./research-library";

type NodeProps = { children?: ReactNode; onChange?: () => void; namespace?: string; componentLibrary?: unknown; llm?: unknown; storage?: unknown; starters?: { prompt: string }[] };
function nodes(node: ReactNode): ReactElement<NodeProps>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<NodeProps>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
beforeEach(() => { state.mode = "ordinary"; state.setMode.mockReset().mockImplementation((mode: string) => { state.mode = mode; }); state.writes.clear(); });

describe("mode selector wiring", () => {
  it("changes transport, library, remount key, starters and message namespace together", () => {
    const ordinaryNodes = nodes(Home());
    const ordinary = ordinaryNodes.find((node) => node.type === AgentInterface)!;
    expect(ordinary.key).toBe("ordinary");
    expect(ordinary.props.componentLibrary).toBe(library);
    expect(ordinaryNodes.find((node) => node.type === SaveMessages)!.props.namespace).toBe("oiu");
    ordinaryNodes.filter((node) => node.type === "input")[1].props.onChange!();
    const researchNodes = nodes(Home());
    const research = researchNodes.find((node) => node.type === AgentInterface)!;
    expect(research.key).toBe("research");
    expect(research.props.componentLibrary).toBe(researchLibrary);
    expect(research.props.llm).not.toBe(ordinary.props.llm);
    expect(researchNodes.find((node) => node.type === SaveMessages)!.props.namespace).toBe("oiu:research");
    expect(research.props.starters![0].prompt).toContain("public sources");
    researchNodes.filter((node) => node.type === "input")[0].props.onChange!();
    const returned = nodes(Home()).find((node) => node.type === AgentInterface)!;
    expect(returned.props.componentLibrary).toBe(library);
    expect(returned.props.llm).toBe(ordinary.props.llm);
    expect(returned.key).toBe("ordinary");
  });
  it("SaveMessages persists reactive selection to the matching namespace", () => {
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => state.writes.set(key, value) });
    SaveMessages({ namespace: "oiu:research" });
    expect(JSON.parse(state.writes.get("oiu:research:messages:thread-test")!)[0].state.selectedIds).toEqual(["c2"]);
    expect(state.writes.has("oiu:messages:thread-test")).toBe(false);
    SaveMessages({});
    expect(state.writes.has("oiu:messages:thread-test")).toBe(true);
    vi.unstubAllGlobals();
  });
});
