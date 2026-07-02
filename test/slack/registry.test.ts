import { describe, it, expect } from "vitest";
import { makeRegistry, reconcileRegistry } from "../../src/slack/registry";
import type { LedgerClient } from "../../src/slack/ledger";

function fakeClient() {
  const messages: any[] = [];
  const client: LedgerClient = {
    async chatPostMessage(a) { messages.unshift({ metadata: a.metadata }); }, // newest-first, like Slack
    async conversationsHistory() { return { messages }; },
  };
  return { client, messages };
}

describe("Registry", () => {
  it("registers a channel and lists it as active", async () => {
    const { client } = fakeClient();
    const reg = makeRegistry(client, "CLEDGER", () => "t");
    await reg.register("C1");
    expect(await reg.listActive()).toEqual(["C1"]);
  });

  it("latest-wins: a later deactivate hides an earlier register", async () => {
    const { client } = fakeClient();
    const reg = makeRegistry(client, "CLEDGER", () => "t");
    await reg.register("C1");
    await reg.deactivate("C1");
    expect(await reg.listActive()).toEqual([]);
  });

  it("reconcile registers new memberships, deactivates departed, and returns the active set", async () => {
    const { client } = fakeClient();
    const reg = makeRegistry(client, "CLEDGER", () => "t");
    await reg.register("C1"); // previously active
    const r1 = await reconcileRegistry(reg, ["C1", "C2"]); // bot now in C1, C2
    expect(r1.added).toEqual(["C2"]);
    expect(r1.removed).toEqual([]);
    expect(r1.active.sort()).toEqual(["C1", "C2"]);
    const r2 = await reconcileRegistry(reg, ["C2"]); // bot left C1
    expect(r2.added).toEqual([]);
    expect(r2.removed).toEqual(["C1"]);
    expect(r2.active).toEqual(["C2"]);
    expect(await reg.listActive()).toEqual(["C2"]);
  });
});
