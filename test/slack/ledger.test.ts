import { describe, it, expect } from "vitest";
import { makeLedger, type LedgerClient } from "../../src/slack/ledger";
import { DECISION_EVENT_TYPE, PROFILE_EVENT_TYPE, type DecisionRecord, type EntityProfile } from "../../src/types";

function fakeClient() {
  const messages: any[] = [];
  const client: LedgerClient = {
    async chatPostMessage(args) {
      // newest-first like Slack: unshift
      messages.unshift({ metadata: args.metadata });
    },
    async conversationsHistory() {
      return { messages };
    },
  };
  return { client, messages };
}

const decision = (id: string, entities: string[]): DecisionRecord => ({
  recordType: "decision_record", id, title: id, status: "decided",
  origin: { channelId: "C1", threadTs: "1.0" }, capturer: "U1", approvers: [],
  decisionText: "x", optionsConsidered: [], rationale: "y", owners: [],
  entities, relatedDecisionIds: [], contextRefs: [],
});

const profile = (entityId: string, summary: string): EntityProfile => ({
  recordType: "entity_profile", entityId,
  static: { summary, keyPeople: [], keySystems: [], decisionNorms: "", builtAt: "t" },
  dynamic: { inFlightDecisions: [], recentThreads: [], openQuestions: [], searchCursor: { untilTs: "0" }, refreshedAt: "t" },
});

describe("Ledger", () => {
  it("writes and reads back a decision via metadata", async () => {
    const { client } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeDecision(decision("d1", ["channel:C1"]));
    const all = await ledger.allDecisions();
    expect(all.map((d) => d.id)).toEqual(["d1"]);
  });

  it("returns latest profile (latest-wins on append)", async () => {
    const { client } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeProfile(profile("channel:C1", "old"));
    await ledger.writeProfile(profile("channel:C1", "new"));
    const p = await ledger.getProfile("channel:C1");
    expect(p?.static.summary).toBe("new");
  });

  it("finds related decisions by shared entity, newest-first, deduped", async () => {
    const { client } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeDecision(decision("d1", ["channel:C1", "project:atlas"]));
    await ledger.writeDecision(decision("d2", ["channel:C9"]));
    await ledger.writeDecision(decision("d3", ["project:atlas"]));
    const related = await ledger.relatedDecisions(["project:atlas"]);
    expect(related.map((d) => d.id)).toEqual(["d3", "d1"]);
  });

  it("tags the right event_type on writes", async () => {
    const { client, messages } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeDecision(decision("d1", []));
    await ledger.writeProfile(profile("channel:C1", "s"));
    expect(messages.map((m) => m.metadata.event_type).sort())
      .toEqual([DECISION_EVENT_TYPE, PROFILE_EVENT_TYPE].sort());
  });

  it("allProfiles returns the latest profile per entity", async () => {
    const { client } = fakeClient();
    const ledger = makeLedger(client, "CLEDGER");
    await ledger.writeProfile(profile("channel:C1", "old"));
    await ledger.writeProfile(profile("channel:C1", "new"));
    await ledger.writeProfile(profile("channel:C2", "two"));
    const all = await ledger.allProfiles();
    expect(all.map((p) => [p.entityId, p.static.summary]).sort())
      .toEqual([["channel:C1", "new"], ["channel:C2", "two"]]);
  });
});
