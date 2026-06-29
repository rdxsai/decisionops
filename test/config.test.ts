// test/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("throws when a required env var is missing", () => {
    expect(() => loadConfig({} as any)).toThrow(/SLACK_BOT_TOKEN/);
  });
  it("loads a complete env", () => {
    const cfg = loadConfig({
      SLACK_BOT_TOKEN: "b", SLACK_APP_TOKEN: "a", SLACK_SIGNING_SECRET: "s",
      SLACK_WORKSPACE_TOKEN: "w", LEDGER_CHANNEL_ID: "C", ANTHROPIC_API_KEY: "k",
    } as any);
    expect(cfg.ledgerChannelId).toBe("C");
  });
});
