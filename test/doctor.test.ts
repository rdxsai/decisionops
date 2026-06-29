import { describe, it, expect } from "vitest";
import { runChecks, formatResults, type SlackProbe, type AnthropicProbe } from "../src/doctor";

const okBot: SlackProbe = {
  authTest: async () => ({ ok: true, team: "Acme", user: "decisionops" }),
  conversationsInfo: async () => ({ ok: true, channel: { name: "decisions", is_member: true, is_private: true } }),
  apiCall: async () => ({ ok: true, semantic_search_enabled: false }),
};
const okUser: SlackProbe = {
  authTest: async () => ({ ok: true, user: "U123" }),
  conversationsInfo: async () => ({ ok: true, channel: { name: "decisions", is_member: true } }),
  apiCall: async () => ({ ok: true, semantic_search_enabled: true }),
};
const okAnthropic: AnthropicProbe = { messages: { create: async () => ({ model: "claude-opus-4-8" }) } };

const deps = (over: Partial<Parameters<typeof runChecks>[0]> = {}) => ({
  bot: okBot, user: okUser, anthropic: okAnthropic, ledgerChannelId: "C1", model: "claude-opus-4-8", ...over,
});

describe("doctor.runChecks", () => {
  it("reports all PASS when every probe succeeds", async () => {
    const results = await runChecks(deps());
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("marks the bot-token check FAIL with a hint when auth.test throws", async () => {
    const badBot: SlackProbe = { ...okBot, authTest: async () => { throw { data: { error: "invalid_auth" } }; } };
    const results = await runChecks(deps({ bot: badBot }));
    const botCheck = results.find((r) => r.name.includes("bot token"))!;
    expect(botCheck.ok).toBe(false);
    expect(botCheck.detail).toContain("invalid_auth");
    expect(botCheck.hint).toBeTruthy();
  });

  it("fails the Ledger check when the bot is not a member of the channel", async () => {
    const botNotMember: SlackProbe = {
      ...okBot,
      conversationsInfo: async () => ({ ok: true, channel: { name: "decisions", is_member: false } }),
    };
    const results = await runChecks(deps({ bot: botNotMember }));
    const ledger = results.find((r) => r.name.includes("Ledger"))!;
    expect(ledger.ok).toBe(false);
    expect(ledger.detail).toMatch(/not a member/);
  });

  it("surfaces enterprise_is_restricted on the RTS check (wrong token type)", async () => {
    const restrictedUser: SlackProbe = {
      ...okUser,
      apiCall: async () => { throw { data: { error: "enterprise_is_restricted" } }; },
    };
    const results = await runChecks(deps({ user: restrictedUser }));
    const rts = results.find((r) => r.name.includes("Real-Time Search"))!;
    expect(rts.ok).toBe(false);
    expect(rts.detail).toContain("enterprise_is_restricted");
  });

  it("reports keyword-first when semantic search is unavailable", async () => {
    const noSemantic: SlackProbe = { ...okUser, apiCall: async () => ({ ok: true, semantic_search_enabled: false }) };
    const results = await runChecks(deps({ user: noSemantic }));
    const rts = results.find((r) => r.name.includes("Real-Time Search"))!;
    expect(rts.ok).toBe(true);
    expect(rts.detail).toMatch(/keyword-first/);
  });
});

describe("doctor.formatResults", () => {
  it("renders PASS/FAIL lines, includes the hint on failures, and summarizes", () => {
    const out = formatResults([
      { name: "A", ok: true, detail: "fine" },
      { name: "B", ok: false, detail: "broke", hint: "do X" },
    ]);
    expect(out).toContain("[PASS] A");
    expect(out).toContain("[FAIL] B");
    expect(out).toContain("do X");
    expect(out).toMatch(/1 check\(s\) failed/);
  });

  it("summarizes success when all checks pass", () => {
    const out = formatResults([{ name: "A", ok: true, detail: "fine" }]);
    expect(out).toMatch(/All checks passed/);
  });
});
