// src/observer/loop.ts
import type { Ledger } from "../slack/ledger.js";
import { reconcileRegistry, type Registry } from "../slack/registry.js";
import type { HistoryReader } from "../slack/history.js";
import type { Llm } from "../agent/llm.js";
import { coldProfile, isRipe, observeActivity } from "../memory/observer.js";
import { entityIdForChannel, type EntityProfile } from "../types.js";

const numTs = (ts: string): number => Number(ts) || 0;

export async function runObserverTick(deps: {
  ledger: Ledger;
  registry: Registry;
  history: HistoryReader;
  permalink: (channelId: string, ts: string) => Promise<string>;
  llm: Llm;
  botMemberships: () => Promise<string[]>;
  threshold: number;
  recentK: number;
  foldWindow: number;
  maxFolds: number;
  now: () => string;
  ledgerChannelId: string;
}): Promise<{ folded: number; skipped: number; deferred: number }> {
  // The Ledger channel is the datastore, not a decision channel — never observe/fold its
  // own bookkeeping messages. Filtering before reconcile also self-heals: if it was ever
  // registered, reconcile now deactivates it since it's absent from active memberships.
  const memberships = (await deps.botMemberships()).filter((id) => id !== deps.ledgerChannelId);
  const { active } = await reconcileRegistry(deps.registry, memberships);

  // One batch read of all profiles per tick (avoids a full ledger scan per channel).
  const byEntity = new Map<string, EntityProfile>();
  for (const p of await deps.ledger.allProfiles()) byEntity.set(p.entityId, p);

  let folded = 0, skipped = 0, deferred = 0;
  for (const channelId of active) {
    const entityId = entityIdForChannel(channelId);
    const prior = byEntity.get(entityId) ?? coldProfile(entityId, deps.now());
    const backlog = await deps.history.readSince(channelId, prior.dynamic.searchCursor.untilTs);

    if (backlog.length === 0 || !isRipe(prior, backlog.length, deps.threshold)) { skipped++; continue; }
    if (folded >= deps.maxFolds) { deferred++; continue; } // per-tick Opus ceiling; backlog waits for next tick

    // Fold OLDEST-first in a bounded window so coverage stays contiguous from the cursor:
    // the cursor advances only to the newest message we actually fold, never past the tail.
    // A backlog larger than the window drains over successive ticks; a capture live-searches
    // whatever isn't folded yet, so warm ≤ cold holds even on a huge cold-start backlog.
    const oldestFirst = [...backlog].sort((x, y) => numTs(x.ts) - numTs(y.ts));
    const window = oldestFirst.slice(0, Math.max(1, deps.foldWindow)).reverse(); // newest-first; clamp guards a misconfigured foldWindow<=0

    const recentRefs = await Promise.all(window.slice(0, deps.recentK).map(async (m) => ({
      permalink: await deps.permalink(channelId, m.ts),
      snippet: m.text.slice(0, 160),
      ts: m.ts,
    })));

    const profile = await observeActivity({ llm: deps.llm, prior, messages: window, recentRefs, now: deps.now() });
    await deps.ledger.writeProfile(profile);
    folded++;
  }
  return { folded, skipped, deferred };
}
