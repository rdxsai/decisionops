import { Llm, cachedSystem } from "./llm.js";
import type { EntityId } from "../types.js";

export interface Resolved {
  decisionStatement: string;
  options: string[];
  entities: EntityId[];
  openQuestions: string[];
  title: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisionStatement: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    entities: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
    title: { type: "string" },
  },
  required: ["decisionStatement", "options", "entities", "openQuestions", "title"],
} as const;

const INSTR =
  "You extract the decision being made from a Slack thread. Identify the decision " +
  "statement, the options considered, the salient entities (people, projects, systems) " +
  "as id strings, any open questions, and a short title. Be precise; do not invent.";

export async function resolveThread(llm: Llm, threadText: string, seedEntities: EntityId[]): Promise<Resolved> {
  const out = await llm.structured<Resolved>({
    system: cachedSystem(INSTR, ""),
    messages: [{ role: "user", content: `Thread:\n${threadText}` }],
    schema: SCHEMA as object,
  });
  const entities = Array.from(new Set([...out.entities, ...seedEntities]));
  return { ...out, entities };
}
