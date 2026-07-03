// src/memory/observer.ts
import { Llm, cachedSystem } from "../agent/llm.js";
import type { DecisionRecord, EntityId, EntityProfile, ChannelMessage, RecentThread } from "../types.js";

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

const numTs = (ts: string): number => Number(ts) || 0;

// Assemble a profile from an LLM `out`, with code authoritative for the entity id,
// builtAt fallback, delta cursor, and refreshedAt.
function buildProfile(
  prior: EntityProfile,
  out: Pick<EntityProfile, "static" | "dynamic">,
  newCursorTs: string,
  now: string,
): EntityProfile {
  // Monotonic guard: never let the cursor regress. Both callers (consolidate on finalize,
  // observeActivity on the async fold) funnel through here, so an older finalize (e.g. the
  // observer already advanced past it) can't roll the cursor backward.
  const cursor = numTs(newCursorTs) >= numTs(prior.dynamic.searchCursor.untilTs)
    ? newCursorTs
    : prior.dynamic.searchCursor.untilTs;
  return {
    recordType: "entity_profile",
    entityId: prior.entityId,
    static: { ...out.static, builtAt: out.static.builtAt || prior.static.builtAt },
    dynamic: { ...out.dynamic, searchCursor: { untilTs: cursor }, refreshedAt: now },
  };
}

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
  return buildProfile(a.prior, out, a.newCursorTs, a.now);
}

// Ripe when there's enough backlog to be worth an LLM fold, or the channel has never
// been folded (cursor still "0") so its very first observation warms it regardless of
// volume. Keyed on the cursor, NOT summary emptiness — so a fold that returns a thin
// summary can't cause a re-fold-every-tick thrash (the cursor advances once folded).
export function isRipe(prior: EntityProfile, messageCount: number, threshold: number): boolean {
  return messageCount >= threshold || prior.dynamic.searchCursor.untilTs === "0";
}

const ACTIVITY_INSTR =
  "You are the memory observer, watching a channel's recent activity (no decision has " +
  "been finalized yet). Fold the recent messages into the entity profile: rewrite `static` " +
  "only if the area's nature, key people, or norms actually drifted, and capture the " +
  "still-open questions the channel is wrestling with. Keep `dynamic` to the delta. Be terse; " +
  "profiles must stay small enough to inject every turn and stable enough to prompt-cache. " +
  "Provenance only — never inline full message bodies. " +
  "Ground every claim in the messages: do NOT add roles, recommendations, outcomes, vendors, " +
  "or norms that are not stated. If a system or vendor is implied but unnamed, do not name it. " +
  "Prefer omitting a detail over inferring one. " +
  "`keyPeople` holds Slack user ids of the stakeholders central to the area's decisions " +
  "(owners/approvers) — user ids only; capture roles named in plain text but lacking a user id " +
  "(e.g. 'eng-lead', 'finance') in `decisionNorms`, not here. " +
  "Keep time-bound deadlines in `dynamic` (open questions), not in `static` norms, since static " +
  "should stay stable across turns.";

// Fold EXACTLY the given messages into the profile. The caller (runObserverTick) passes a
// bounded, contiguous-from-the-cursor window (oldest-first coverage), so folding all of
// them and advancing the cursor to their newest ts keeps coverage contiguous — the cursor
// never jumps past a message that wasn't folded. ALWAYS calls the LLM; the loop gates on isRipe.
export async function observeActivity(a: {
  llm: Llm; prior: EntityProfile;
  messages: ChannelMessage[];
  recentRefs: RecentThread[];
  now: string;
}): Promise<EntityProfile> {
  // Cursor advances to the verbatim newest of exactly the folded messages, guarded monotonic.
  const newCursorTs = a.messages.reduce(
    (max, m) => (numTs(m.ts) > numTs(max) ? m.ts : max),
    a.prior.dynamic.searchCursor.untilTs,
  );
  const out = await a.llm.structured<Pick<EntityProfile, "static" | "dynamic">>({
    system: cachedSystem(ACTIVITY_INSTR, ""),
    messages: [{ role: "user", content:
      `Prior profile:\n${JSON.stringify(a.prior)}\n\n` +
      `Messages to fold (newest first):\n${JSON.stringify(a.messages.map((m) => ({ user: m.user, text: m.text })))}` }],
    schema: SCHEMA as object,
  });
  return buildProfile(
    a.prior,
    { static: out.static, dynamic: { ...out.dynamic, recentThreads: a.recentRefs } },
    newCursorTs, a.now);
}
