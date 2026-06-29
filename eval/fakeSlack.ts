// eval/fakeSlack.ts
import type { LedgerClient } from "../src/slack/ledger.js";
import type { RtsClient } from "../src/rts/search.js";

export function makeFakeSlack() {
  const messages: any[] = [];
  let calls = 0;
  let result = [{ permalink: "p", channel_id: "C1", ts: "1.0", text: "ctx", is_private: false }];

  const ledgerClient: LedgerClient = {
    async chatPostMessage(a) { messages.unshift({ metadata: a.metadata }); },
    async conversationsHistory() { return { messages }; },
  };
  const rts: RtsClient = {
    async searchContext() { calls++; return { results: { messages: result } }; },
    async searchInfo() { return { semantic_search_enabled: false }; },
  };
  return {
    ledgerClient, rts,
    searchCalls: () => calls,
    seedSearchResult(r: typeof result) { result = r; },
    raw: messages,
  };
}
