"use client";
import "@/lib/devtools";
import "@openuidev/react-ui/styles/index.css";
import "./shell.css";

import {
  AgentInterface,
  fetchLLM,
  openAIConversationMessageFormat,
  openAIResponsesAdapter,
} from "@openuidev/react-ui";
import type { ActionEvent } from "@openuidev/react-lang";
import { runLibraryAction } from "@/lib/actions";
import { localChatStorage, SaveMessages } from "@/lib/chat-storage";
import { library } from "@/lib/library";
import { responseTheme } from "@/lib/response-theme";
import { researchLibrary } from "@/lib/research-library";
import { useState } from "react";

const starters = [
  { displayText: "Plan a day out", prompt: "I'm in San Francisco for a day, plan a sightseeing route for me", icon: null },
  { displayText: "Explore a city", prompt: "Plan a relaxed afternoon exploring Lisbon, with three stops and a map", icon: null },
  { displayText: "Find weekend ideas", prompt: "Help me find a weekend getaway from San Francisco. Compare three destinations", icon: null },
  { displayText: "Plan a meal", prompt: "Help me plan a simple vegetarian dinner for six people", icon: null },
];

const llm = fetchLLM({
  url: "/api/chat",
  streamAdapter: openAIResponsesAdapter(),
  messageFormat: openAIConversationMessageFormat,
});

const researchLlm = fetchLLM({
  url: "/api/chat",
  streamAdapter: openAIResponsesAdapter(),
  messageFormat: openAIConversationMessageFormat,
  body: { researchMode: true },
});

const researchStarters = [
  { displayText: "Compare science museums", prompt: "Compare the Exploratorium, California Academy of Sciences, and Lawrence Hall of Science for a family afternoon. Use public sources to compare their focus and hands-on activities. Let me shortlist options. Mark anything the evidence does not establish as uncertain; skip prices, hours, and rankings.", icon: null },
];

// Threads and messages persist in localStorage (created once, on the client).
const storage = typeof window === "undefined" ? undefined : localChatStorage();
const researchStorage = typeof window === "undefined" ? undefined : localChatStorage("oiu:research");

// The chat sends @ToAssistant and opens @OpenUrl itself; every other action,
// such as the library's @CopyToClipboard, reaches onAction.
function onAction(event: ActionEvent) {
  void runLibraryAction(event);
}

export default function Home() {
  const [mode, setMode] = useState<"ordinary" | "research">("ordinary");
  const research = mode === "research";
  return (
    <div className="chat-shell chat-shell-with-modes">
      <div className="chat-mode-bar">
        <fieldset className="chat-modes"><legend className="research-sr-only">Answer mode</legend>
          <label><input type="radio" name="answer-mode" checked={!research} onChange={() => setMode("ordinary")} /><span>Chat</span></label>
          <label><input type="radio" name="answer-mode" checked={research} onChange={() => setMode("research")} /><span>Research <small>Preview</small></span></label>
        </fieldset>
        <p>{research ? "Compare with sources · separate research chats" : "Interactive answers, made for your question"}</p>
      </div>
      <AgentInterface
        key={mode}
        llm={research ? researchLlm : llm}
        storage={research ? researchStorage : storage}
        componentLibrary={research ? researchLibrary : library}
        onAction={onAction}
        agentName="OpenUI"
        theme={{ mode: "light", lightTheme: responseTheme }}
        starters={research ? researchStarters : starters}
        starterVariant="short"
      >
        <AgentInterface.Welcome title={research ? "What would you like to compare?" : "What can I help with?"} />
        <SaveMessages namespace={research ? "oiu:research" : "oiu"} />
      </AgentInterface>
    </div>
  );
}
