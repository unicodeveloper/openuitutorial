import { createLibrary } from "@openuidev/react-lang";
import { Col } from "./components/layout";
import { ResearchComparison } from "./components/research-comparison";

export const researchLibrary = createLibrary({
  root: "Col",
  components: [Col, ResearchComparison],
  componentGroups: [{
    name: "Evidence comparison",
    components: ["Col", "ResearchComparison"],
    notes: [
      "Use Col([comparison]) as the root. ResearchComparison arguments are snapshotId, options, $selectedIds, optional title, in that order.",
      "Use only canonical source IDs from the supplied snapshot. Describe unknown facts as uncertain; unmatched source IDs render as unsupported. Never supply URLs, tools, actions, or invented candidates.",
    ],
  }],
});

export { researchPromptOptions } from "./research-prompt-options";
