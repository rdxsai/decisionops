import { Llm, cachedSystem, dynamicSystemMessage } from "./llm.js";
import type { ContextRef } from "../types.js";
import type { Resolved } from "./resolve.js";

export interface Brief {
  title: string;
  decisionText: string;
  optionsConsidered: string[];
  rationale: string;
  proposedOwners: { userId: string; task: string }[];
  openQuestions: string[];
  bodySummary: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    decisionText: { type: "string" },
    optionsConsidered: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
    proposedOwners: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { userId: { type: "string" }, task: { type: "string" } },
        required: ["userId", "task"],
      },
    },
    openQuestions: { type: "array", items: { type: "string" } },
    bodySummary: { type: "string" },
  },
  required: ["title", "decisionText", "optionsConsidered", "rationale", "proposedOwners", "openQuestions", "bodySummary"],
} as const;

const INSTR =
  "You write a crisp decision brief. Use ONLY the supplied thread, retrieved context, " +
  "and standing context. State the decision, the options considered, the rationale, " +
  "proposed owners (with user ids when named), and any still-open questions. " +
  "`bodySummary` is a few human-readable sentences for a channel reader.";

export async function synthesizeBrief(a: {
  llm: Llm; staticProfile: string; dynamicProfile: string;
  resolved: Resolved; refs: ContextRef[];
}): Promise<Brief> {
  const refsText = a.refs.map((r) => `- ${r.snippet} (${r.permalink})`).join("\n");
  return a.llm.structured<Brief>({
    system: cachedSystem(INSTR, a.staticProfile),
    messages: [
      { role: "user", content:
        `Decision: ${a.resolved.decisionStatement}\nOptions: ${a.resolved.options.join(", ")}\n` +
        `Open questions: ${a.resolved.openQuestions.join("; ")}\nRetrieved context:\n${refsText}` },
      dynamicSystemMessage(a.dynamicProfile),
    ],
    schema: SCHEMA as object,
  });
}
