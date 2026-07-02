// src/agent/capture.ts
import type { Ledger } from "../slack/ledger.js";
import type { Search } from "../rts/search.js";
import type { SearchBudget } from "../rts/budget.js";
import { Llm } from "./llm.js";
import { resolveThread, type Resolved } from "./resolve.js";
import { gatherContext } from "./gapcheck.js";
import { synthesizeBrief, type Brief } from "./synthesize.js";
import { coldProfile } from "../memory/observer.js";
import { entityIdForChannel, type ContextRef, type EntityProfile } from "../types.js";

export interface CaptureInput {
  channelId: string;
  threadTs: string;
  capturer: string;
  threadText: string;
}

export interface CaptureResult {
  brief: Brief;
  refs: ContextRef[];
  resolved: Resolved;
  profile: EntityProfile;
  rtsCalls: number;
}

const profileToStatic = (p: EntityProfile): string => JSON.stringify(p.static);
const profileToDynamic = (p: EntityProfile): string => JSON.stringify(p.dynamic);

export async function runCapture(
  deps: { ledger: Ledger; llm: Llm; search: Search; budget: SearchBudget; now: string },
  input: CaptureInput
): Promise<CaptureResult> {
  const seed = entityIdForChannel(input.channelId);

  // Step 3: resolve the decision from the thread.
  const resolved = await resolveThread(deps.llm, input.threadText, [seed]);

  // Step 4 (Recall): key memory on the channel the decision lives in — a stable,
  // always-present anchor and the single source of truth for the profile key (finalize
  // reuses `profile.entityId`, so read == write). Deliberately NOT resolved.entities[0]:
  // the resolver often lists a person first, which would fragment warm-start onto an
  // individual. Project-level cross-channel keying is a future step — it needs resolve.ts
  // to emit canonical `project:` ids (see UPDATE.md), so it's out of scope for v1.
  const primaryEntity = seed;
  const profile =
    (await deps.ledger.getProfile(primaryEntity)) ?? coldProfile(primaryEntity, deps.now);

  // Steps 5–6: bounded, delta-scoped gap search (cursor lives in the dynamic profile).
  const refs = await gatherContext({
    llm: deps.llm, search: deps.search,
    staticProfile: profileToStatic(profile),
    dynamicProfile: profileToDynamic(profile),
    resolved,
    afterTs: profile.dynamic.searchCursor.untilTs, // delta cursor: "0" cold, last-seen ts warm
  });

  // Step 7: synthesize the brief.
  const brief = await synthesizeBrief({
    llm: deps.llm, staticProfile: profileToStatic(profile),
    dynamicProfile: profileToDynamic(profile), resolved, refs,
  });

  return { brief, refs, resolved, profile, rtsCalls: deps.budget.spent() };
}
