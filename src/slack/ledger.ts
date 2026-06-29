import {
  DECISION_EVENT_TYPE, PROFILE_EVENT_TYPE,
  isDecisionRecord, isEntityProfile,
  type DecisionRecord, type EntityProfile, type EntityId,
} from "../types.js";

export interface LedgerClient {
  chatPostMessage(args: {
    channel: string;
    text: string;
    metadata: { event_type: string; event_payload: Record<string, any> };
  }): Promise<void>;
  conversationsHistory(args: {
    channel: string;
    include_all_metadata: true;
    cursor?: string;
  }): Promise<{
    messages: Array<{ metadata?: { event_type: string; event_payload: any } }>;
    response_metadata?: { next_cursor?: string };
  }>;
}

export interface Ledger {
  writeDecision(r: DecisionRecord): Promise<void>;
  writeProfile(p: EntityProfile): Promise<void>;
  getProfile(id: EntityId): Promise<EntityProfile | null>;
  relatedDecisions(entities: EntityId[]): Promise<DecisionRecord[]>;
  allDecisions(): Promise<DecisionRecord[]>;
}

const summarize = (r: DecisionRecord | EntityProfile): string =>
  isDecisionRecord(r)
    ? `Decision: ${r.title} [${r.status}]`
    : `Profile: ${r.entityId}`;

export function makeLedger(client: LedgerClient, channelId: string): Ledger {
  // Read entire channel (newest-first), paging until exhausted.
  async function readAll(): Promise<Array<DecisionRecord | EntityProfile>> {
    const out: Array<DecisionRecord | EntityProfile> = [];
    let cursor: string | undefined;
    do {
      const res = await client.conversationsHistory({
        channel: channelId, include_all_metadata: true, cursor,
      });
      for (const m of res.messages ?? []) {
        const p = m.metadata?.event_payload;
        if (isDecisionRecord(p) || isEntityProfile(p)) out.push(p);
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out; // newest-first
  }

  async function write(payload: DecisionRecord | EntityProfile, eventType: string) {
    await client.chatPostMessage({
      channel: channelId,
      text: summarize(payload),
      metadata: { event_type: eventType, event_payload: payload },
    });
  }

  return {
    writeDecision: (r) => write(r, DECISION_EVENT_TYPE),
    writeProfile: (p) => write(p, PROFILE_EVENT_TYPE),

    async getProfile(id) {
      const all = await readAll(); // newest-first => first match is latest
      for (const r of all) if (isEntityProfile(r) && r.entityId === id) return r;
      return null;
    },

    async allDecisions() {
      const seen = new Set<string>();
      const out: DecisionRecord[] = [];
      for (const r of await readAll()) {
        if (isDecisionRecord(r) && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
      }
      return out;
    },

    async relatedDecisions(entities) {
      const want = new Set(entities);
      const all = await this.allDecisions(); // already newest-first, deduped
      return all.filter((d) => d.entities.some((e) => want.has(e)));
    },
  };
}
