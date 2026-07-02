// eval/fakeSlack.ts
import type { LedgerClient } from "../src/slack/ledger.js";
import type { RtsClient } from "../src/rts/search.js";
import type { HistoryClient } from "../src/slack/history.js";

export function makeFakeSlack() {
  const messages: any[] = [];
  let calls = 0;
  let result = [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "ctx", is_private: false }];
  const channels: Record<string, { ts: string; user?: string; text?: string }[]> = {};
  let members: string[] = [];

  const ledgerClient: LedgerClient = {
    async chatPostMessage(a) { messages.unshift({ metadata: a.metadata }); },
    async conversationsHistory() { return { messages }; },
  };
  const rts: RtsClient = {
    async searchContext() { calls++; return { results: { messages: result } }; },
    async searchInfo() { return { semantic_search_enabled: false }; },
  };
  const historyClient: HistoryClient = {
    async conversationsHistory(a) {
      const msgs = (channels[a.channel] ?? [])
        .filter((m) => !a.oldest || Number(m.ts) > Number(a.oldest))
        .sort((x, y) => Number(y.ts) - Number(x.ts));
      return { messages: msgs };
    },
  };
  return {
    ledgerClient, rts, historyClient,
    searchCalls: () => calls,
    seedSearchResult(r: typeof result) { result = r; },
    seedChannel(id: string, msgs: { ts: string; user?: string; text?: string }[]) { channels[id] = msgs; },
    setMemberships(ids: string[]) { members = ids; },
    memberships: () => members,
    permalink: async (channelId: string, ts: string) => `https://x/${channelId}/${ts}`,
    raw: messages,
  };
}
