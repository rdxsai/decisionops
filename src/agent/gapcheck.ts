import { Llm, cachedSystem, dynamicSystemMessage } from "./llm.js";
import type { Search } from "../rts/search.js";
import type { ContextRef } from "../types.js";
import type { Resolved } from "./resolve.js";

const INSTR =
  "You are filling gaps for a decision brief. You already have the standing context " +
  "below. Call `search` ONLY for what is genuinely missing — prior related decisions, " +
  "owners, constraints. Each query is a real-time workspace search run AS the invoking " +
  "user. Prefer a question phrasing. Stop as soon as the brief's open questions are " +
  "answerable. When done, reply with a one-line note; do not call search again.";

const SEARCH_TOOL = {
  name: "search",
  description: "Search the Slack workspace (as the invoking user) for context relevant to the decision.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string", description: "Natural-language search query" } },
    required: ["query"],
  },
};

export async function gatherContext(a: {
  llm: Llm; search: Search;
  staticProfile: string; dynamicProfile: string; resolved: Resolved;
  afterTs: string; // the entity's dynamic.searchCursor.untilTs ("0" = cold / search all time)
}): Promise<ContextRef[]> {
  const refs: ContextRef[] = [];
  await a.llm.toolLoop({
    system: cachedSystem(INSTR, a.staticProfile),
    messages: [
      dynamicSystemMessage(a.dynamicProfile),
      { role: "user", content:
        `Decision: ${a.resolved.decisionStatement}\nOpen questions: ${a.resolved.openQuestions.join("; ")}` },
    ],
    tools: [SEARCH_TOOL],
    maxIterations: 6,
    onToolUse: async (_name, input) => {
      const found = await a.search.run(input.query, { afterTs: a.afterTs }); // delta-scoped
      refs.push(...found);
      return found.length
        ? found.map((r) => `- ${r.snippet} (${r.permalink})`).join("\n")
        : "No new results.";
    },
  });
  return refs;
}
