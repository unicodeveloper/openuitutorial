import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceSnapshot } from "../research/types";

// A deterministic hook/element harness: exercises handlers and effect dependencies
// without claiming browser layout, focus behavior, or native <details> execution.
const harness = vi.hoisted(() => ({
  read: null as unknown,
  filter: false,
  selection: [] as string[],
  streaming: false,
  effectId: undefined as string | undefined,
  cleanup: undefined as undefined | (() => void),
  setValue: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "comparison-test",
  useState: (initial: unknown) => initial === false
    ? [harness.filter, (value: boolean) => { harness.filter = value; }]
    : [harness.read, (value: unknown) => { harness.read = value; }],
  useEffect: (effect: () => undefined | (() => void), deps: string[]) => {
    if (harness.effectId !== deps[0]) {
      harness.cleanup?.();
      harness.effectId = deps[0];
      harness.cleanup = effect();
    }
  },
}));
vi.mock("@openuidev/react-lang", async (original) => ({
  ...await original<typeof import("@openuidev/react-lang")>(),
  useIsStreaming: () => harness.streaming,
  useStateField: () => ({ name: "selectedIds", isReactive: true, value: harness.selection, setValue: harness.setValue }),
}));
import { ResearchComparison, ResearchComparisonView, type ResearchOption } from "./research-comparison";

const id = "0123456789abcdef0123456789abcdef";
const secondId = "1123456789abcdef0123456789abcdef";
const options: ResearchOption[] = [
  { id: "c1", label: "Science museum", claims: [{ criterion: "Activities", statement: "Hands-on exhibits.", sourceIds: ["s1"], evidenceStatus: "supported" }] },
  { id: "c2", label: "Another museum", claims: [{ criterion: "Activities", statement: "Hands-on exhibits.", sourceIds: ["s1"], evidenceStatus: "supported" }] },
];
const snapshot = (snapshotId = id): EvidenceSnapshot => ({
  version: 1, snapshotId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(), status: "ready", partial: false, error: null,
  sources: [{ id: "s1", title: "Museum activities", excerpt: "Hands-on exhibits.", url: "https://example.org/activities", source: "example.org", publicationDate: null, relevanceScore: null, retrievedAt: new Date().toISOString() }],
});

type ElementProps = { children?: ReactNode; type?: string; disabled?: boolean; checked?: boolean; onChange?: (event: { target: { checked: boolean } }) => void; onClick?: () => void };
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
const wrapper = ResearchComparison.component as unknown as (args: { props: Record<string, unknown>; statementId: string }) => ReactElement<Parameters<typeof ResearchComparisonView>[0]>;
const render = (snapshotId = id, overrides = {}) => {
  const element = wrapper({ props: { snapshotId, options, selectedIds: harness.selection, ...overrides }, statementId: "comparison" });
  return { props: element.props, nodes: elements(ResearchComparisonView(element.props)) };
};
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

beforeEach(() => {
  harness.read = null; harness.filter = false; harness.selection = []; harness.streaming = false; harness.effectId = undefined; harness.cleanup = undefined;
  harness.setValue.mockReset().mockImplementation((ids: string[]) => { harness.selection = ids; });
});
afterEach(async () => { harness.cleanup?.(); await settle(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("comparison handlers and snapshot effect dependencies", () => {
  it("selects multiple options, filters the shortlist, and returns to all options without another read", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(snapshot()));
    vi.stubGlobal("fetch", fetcher);
    render(); await settle();
    let ui = render();
    let checkboxes = ui.nodes.filter((node) => node.type === "input");
    checkboxes[1].props.onChange!({ target: { checked: true } });
    expect(harness.selection).toEqual(["c1"]);
    ui = render();
    checkboxes = ui.nodes.filter((node) => node.type === "input");
    checkboxes[2].props.onChange!({ target: { checked: true } });
    expect(harness.selection).toEqual(["c1", "c2"]);
    render().nodes.filter((node) => node.type === "input")[1].props.onChange!({ target: { checked: false } });
    expect(harness.selection).toEqual(["c2"]);
    render().nodes.filter((node) => node.type === "input")[0].props.onChange!({ target: { checked: true } });
    expect(render().nodes.filter((node) => node.type === "article")).toHaveLength(1);
    render().nodes.filter((node) => node.type === "input")[1].props.onChange!({ target: { checked: false } });
    ui = render();
    expect(ui.nodes.filter((node) => node.type === "article")).toHaveLength(0);
    ui.nodes.find((node) => node.type === "button")!.props.onClick!();
    expect(render().nodes.filter((node) => node.type === "article")).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/research/snapshots/${id}`);
  });
  it("passes partial props safely and does not fetch incomplete snapshot IDs", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    harness.streaming = true;
    expect(() => render("0123", { options: [null], title: {} })).not.toThrow();
    expect(render("0123").props.read.status).toBe("loading");
    expect(fetcher).not.toHaveBeenCalled();
    harness.streaming = false;
    expect(render("0123").props.read.status).toBe("unavailable");
  });
  it("blocks a streaming selection write even if an event is invoked directly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot())));
    render(); await settle();
    harness.streaming = true;
    const ui = render();
    expect(ui.nodes.filter((node) => node.type === "input")[1].props.disabled).toBe(true);
    ui.props.onSelect(["c1"]);
    expect(harness.setValue).not.toHaveBeenCalled();
  });
  it("expires the mounted evidence without refetching and blocks stale selection handlers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(Response.json(snapshot()));
    vi.stubGlobal("fetch", fetcher);
    render(); await settle();
    const old = render();
    expect(old.props.read.status).toBe("loaded");
    await vi.advanceTimersByTimeAsync(900_001);
    expect(render().props.read.status).toBe("expired");
    expect(render().nodes.filter((node) => node.type === "a" || node.type === "input")).toHaveLength(0);
    old.props.onSelect(["c1"]);
    expect(harness.setValue).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("hides old evidence immediately on snapshot change and ignores cancelled responses", async () => {
    let finishFirst: (value: Response) => void = () => {};
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(Response.json(snapshot(secondId)));
    vi.stubGlobal("fetch", fetcher);
    render();
    expect(render(secondId).props.read.status).toBe("loading");
    await settle();
    expect((fetcher.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    finishFirst(Response.json(snapshot())); await settle();
    const read = render(secondId).props.read;
    expect(read.status).toBe("loaded");
    if (read.status === "loaded") expect(read.snapshot.snapshotId).toBe(secondId);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
