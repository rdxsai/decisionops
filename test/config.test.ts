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
  it("defaults observer settings when unset and parses overrides", () => {
    const base = {
      SLACK_BOT_TOKEN: "b", SLACK_APP_TOKEN: "a", SLACK_SIGNING_SECRET: "s",
      SLACK_WORKSPACE_TOKEN: "w", LEDGER_CHANNEL_ID: "C", ANTHROPIC_API_KEY: "k",
    };
    const def = loadConfig({ ...base } as any);
    expect(def.observerEnabled).toBe(false);
    expect(def.observerIntervalMs).toBe(300000);
    expect(def.observerThreshold).toBe(8);
    expect(def.observerFoldWindow).toBe(50);
    expect(def.observerMaxFoldsPerTick).toBe(3);
    const over = loadConfig({ ...base, OBSERVER_ENABLED: "true", OBSERVER_CONSOLIDATE_THRESHOLD: "5", OBSERVER_MAX_FOLDS_PER_TICK: "1" } as any);
    expect(over.observerEnabled).toBe(true);
    expect(over.observerThreshold).toBe(5);
    expect(over.observerMaxFoldsPerTick).toBe(1);
  });
});
