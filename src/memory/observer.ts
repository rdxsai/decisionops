// src/memory/observer.ts
import { Llm, cachedSystem } from "../agent/llm.js";
import type { DecisionRecord, EntityId, EntityProfile } from "../types.js";

export function coldProfile(entityId: EntityId, now: string): EntityProfile {
  return {
    recordType: "entity_profile",
    entityId,
    static: { summary: "", keyPeople: [], keySystems: [], decisionNorms: "", builtAt: now },
    dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "0" }, refreshedAt: now },
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    static: {
      type: "object", additionalProperties: false,
      properties: {
        summary: { type: "string" }, keyPeople: { type: "array", items: { type: "string" } },
        keySystems: { type: "array", items: { type: "string" } }, decisionNorms: { type: "string" }, builtAt: { type: "string" },
      },
      required: ["summary", "keyPeople", "keySystems", "decisionNorms", "builtAt"],
    },
    dynamic: {
      type: "object", additionalProperties: false,
      properties: {
        inFlightDecisions: { type: "array", items: { type: "string" } },
        recentThreads: { type: "array", items: { type: "object", additionalProperties: false,
          properties: { permalink: { type: "string" }, snippet: { type: "string" }, ts: { type: "string" } },
          required: ["permalink", "snippet", "ts"] } },
        openQuestions: { type: "array", items: { type: "string" } },
        searchCursor: { type: "object", additionalProperties: false, properties: { untilTs: { type: "string" } }, required: ["untilTs"] },
        refreshedAt: { type: "string" },
      },
      required: ["inFlightDecisions", "recentThreads", "openQuestions", "searchCursor", "refreshedAt"],
    },
  },
  required: ["static", "dynamic"],
} as const;

const INSTR =
  "You are the memory observer. Fold the newly finalized decision and recent threads " +
  "into a compact entity profile. Keep `static` stable — only rewrite it if the area's " +
  "nature, key people, or norms actually drifted. Keep `dynamic` to the delta: in-flight " +
  "decision ids, a few recent threads, and still-open questions. Be terse; profiles must " +
  "stay small enough to inject every turn and stable enough to prompt-cache. Provenance " +
  "only — snippets, never full bodies.";

export async function consolidate(a: {
  llm: Llm; prior: EntityProfile; newDecision: DecisionRecord;
  recentRefs: { permalink: string; snippet: string; ts: string }[];
  newCursorTs: string; now: string;
}): Promise<EntityProfile> {
  const out = await a.llm.structured<Pick<EntityProfile, "static" | "dynamic">>({
    system: cachedSystem(INSTR, ""),
    messages: [{ role: "user", content:
      `Prior profile:\n${JSON.stringify(a.prior)}\n\n` +
      `Newly finalized decision:\n${JSON.stringify({ id: a.newDecision.id, title: a.newDecision.title, decisionText: a.newDecision.decisionText, rationale: a.newDecision.rationale })}\n\n` +
      `Recent threads:\n${JSON.stringify(a.recentRefs)}` }],
    schema: SCHEMA as object,
  });
  // Code is authoritative for the cursor and refreshedAt — never trust the model here.
  return {
    recordType: "entity_profile",
    entityId: a.prior.entityId,
    static: { ...out.static, builtAt: out.static.builtAt || a.prior.static.builtAt },
    dynamic: { ...out.dynamic, searchCursor: { untilTs: a.newCursorTs }, refreshedAt: a.now },
  };
}
