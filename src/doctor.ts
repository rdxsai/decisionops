// Preflight diagnostics: validates every external dependency before `npm run dev`.
// Run with `npm run doctor`. Each check is independent and reports a remediation hint on failure.
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { MODEL } from "./agent/llm.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

// Minimal probes so checks are unit-testable; real WebClient/Anthropic are adapted in main().
export interface SlackProbe {
  authTest(): Promise<{ ok?: boolean; team?: string; user?: string }>;
  conversationsInfo(args: { channel: string }): Promise<{
    ok?: boolean;
    channel?: { name?: string; is_member?: boolean; is_private?: boolean };
  }>;
  apiCall(method: string, args?: Record<string, unknown>): Promise<any>;
}

export interface AnthropicProbe {
  messages: { create(req: unknown): Promise<{ model?: string }> };
}

export interface DoctorDeps {
  bot: SlackProbe;
  user: SlackProbe;
  anthropic: AnthropicProbe;
  ledgerChannelId: string;
  model: string;
}

const errText = (e: any): string => e?.data?.error ?? e?.message ?? String(e);

export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const run = async (name: string, fn: () => Promise<string>, hint: string) => {
    try {
      results.push({ name, ok: true, detail: await fn() });
    } catch (e) {
      results.push({ name, ok: false, detail: errText(e), hint });
    }
  };

  await run("Slack bot token (auth.test)", async () => {
    const r = await deps.bot.authTest();
    if (!r.ok) throw new Error("auth.test returned ok=false");
    return `team=${r.team} bot_user=${r.user}`;
  }, "Set SLACK_BOT_TOKEN to the app's xoxb- bot token (OAuth & Permissions page).");

  await run("Slack user token (auth.test)", async () => {
    const r = await deps.user.authTest();
    if (!r.ok) throw new Error("auth.test returned ok=false");
    return `user=${r.user}`;
  }, "Set SLACK_WORKSPACE_TOKEN to your xoxp- user token — RTS searches AS you, so it must be a user token, not the bot token.");

  await run("Ledger channel reachable + bot is a member", async () => {
    const r = await deps.bot.conversationsInfo({ channel: deps.ledgerChannelId });
    if (!r.ok || !r.channel) throw new Error("channel not found (check LEDGER_CHANNEL_ID)");
    if (!r.channel.is_member) throw new Error(`bot is not a member of #${r.channel.name}`);
    return `#${r.channel.name} (private=${!!r.channel.is_private}) — bot is a member`;
  }, "Create a private Ledger channel, run `/invite @your-bot`, and set LEDGER_CHANNEL_ID to its ID.");

  await run("Real-Time Search available", async () => {
    const r = await deps.user.apiCall("assistant.search.info");
    if (!r.ok) throw new Error(r.error ?? "assistant.search.info failed");
    const semantic = !!(r.semantic_search_enabled ?? r?.workspace?.semantic_search_enabled);
    return `reachable; semantic_search_enabled=${semantic}${semantic ? "" : " (keyword-first mode)"}`;
  }, "Call RTS with a workspace (not org/Grid) token and grant search:read.public. `enterprise_is_restricted` = use a workspace-level token.");

  await run("Anthropic API + model access", async () => {
    const r = await deps.anthropic.messages.create({
      model: deps.model,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    });
    return `model=${r.model ?? deps.model} reachable`;
  }, "Set ANTHROPIC_API_KEY and confirm your org has access to the model.");

  return results;
}

export function formatResults(results: CheckResult[]): string {
  const lines = results.map((r) => {
    const base = `[${r.ok ? "PASS" : "FAIL"}] ${r.name}: ${r.detail}`;
    return r.ok ? base : `${base}\n        ↳ ${r.hint ?? ""}`;
  });
  const failed = results.filter((r) => !r.ok).length;
  lines.push("");
  lines.push(
    failed === 0
      ? "All checks passed — you're ready to `npm run dev`."
      : `${failed} check(s) failed — fix the above, then re-run \`npm run doctor\`.`,
  );
  return lines.join("\n");
}

function adapt(c: WebClient): SlackProbe {
  return {
    authTest: () => c.auth.test() as Promise<any>,
    conversationsInfo: (a) => c.conversations.info(a) as Promise<any>,
    apiCall: (m, a) => c.apiCall(m, a as any) as Promise<any>,
  };
}

async function main() {
  const cfg = loadConfig(process.env);
  const results = await runChecks({
    bot: adapt(new WebClient(cfg.botToken)),
    user: adapt(new WebClient(cfg.workspaceToken)),
    anthropic: new Anthropic({ apiKey: cfg.anthropicKey }) as unknown as AnthropicProbe,
    ledgerChannelId: cfg.ledgerChannelId,
    model: MODEL,
  });
  console.log(formatResults(results));
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`doctor: ${e?.message ?? e}`);
    console.error("(fill .env from .env.example — see SETUP.md)");
    process.exit(1);
  });
}
