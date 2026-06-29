// Dev helper: post a few realistic decision threads into a channel so a fresh
// workspace has something to capture and for Real-Time Search to index.
// Usage: npm run seed -- <CHANNEL_ID>   (the bot must be a member of that channel)
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";

export interface SeedThread {
  text: string; // parent message
  replies: string[];
}

export function seedThreads(): SeedThread[] {
  return [
    {
      text: "Decision needed: do we move the billing service off DynamoDB to Postgres before the Q3 migration?",
      replies: [
        "Postgres gives us real transactions + joins for invoice reconciliation — Dynamo has been painful there.",
        "Cost is roughly a wash at our volume. The real risk is the cutover; we'd need a dual-write window.",
        "Agreed on Postgres. Owner: eng-lead to spec the migration; finance sign-off needed before we start.",
      ],
    },
    {
      text: "Auth provider for the new customer portal — Auth0 vs Amazon Cognito vs build our own?",
      replies: [
        "Building our own is a no — too much surface area for a 3-person team.",
        "Auth0 is faster to integrate with better docs; Cognito is cheaper but the DX is rough.",
        "Let's go Auth0 for v1 and revisit cost at scale. Owner: platform team.",
      ],
    },
    {
      text: "Do we keep 2-week sprints or move the platform team to continuous/kanban?",
      replies: [
        "Kanban fits our interrupt-heavy support load better than fixed sprints.",
        "Counterpoint: sprints give stakeholders a predictable release cadence.",
        "Compromise: kanban for the platform team, keep a demo every 2 weeks for visibility.",
      ],
    },
    {
      text: "Product analytics vendor: Amplitude or Mixpanel?",
      replies: [
        "Amplitude's behavioral cohorts are stronger for our retention questions.",
        "Mixpanel is cheaper and the team already knows it.",
        "Going with Amplitude — the cohort analysis is the deciding factor. Owner: data team.",
      ],
    },
  ];
}

async function main() {
  const channel = process.argv[2];
  if (!channel) {
    console.error("usage: npm run seed -- <CHANNEL_ID>   (e.g. the channel ID of #general)");
    process.exit(2);
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN missing — fill .env (see SETUP.md).");
    process.exit(1);
  }
  const client = new WebClient(token);
  const threads = seedThreads();
  for (const t of threads) {
    const parent = await client.chat.postMessage({ channel, text: t.text });
    const ts = parent.ts as string;
    for (const r of t.replies) {
      await client.chat.postMessage({ channel, text: r, thread_ts: ts });
      await new Promise((res) => setTimeout(res, 400)); // stay under ~1 msg/sec/channel
    }
    console.log(`seeded: ${t.text.slice(0, 64)}…`);
    await new Promise((res) => setTimeout(res, 400));
  }
  console.log(`\nDone — ${threads.length} decision threads posted to ${channel}.`);
  console.log('Run "Capture decision" on any of those parent messages.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e: any) => {
    console.error(`seed: ${e?.data?.error ?? e?.message ?? e}`);
    if (e?.data?.error === "not_in_channel") {
      console.error("→ /invite @decisionops to that channel first.");
    }
    process.exit(1);
  });
}
