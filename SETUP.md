# DecisionOps — Real-API Setup & Verification

This is the ~10-minute setup to run DecisionOps against a real Slack workspace and the
Anthropic API. Everything in this repo is tested against mocks; this is where the live
integration gets validated. Run `npm run doctor` after each step to check your progress.

> **Prereqs:** Node 20+, a Slack workspace where you can create + install an internal app
> (your hackathon **developer sandbox** works), and an Anthropic API key.

## 1. Create the Slack app from the manifest
1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace, then paste the contents of [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).
3. Create the app.

## 2. Generate an App-Level Token (for Socket Mode)
- **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**.
- Name it `socket`, add the scope **`connections:write`**, generate.
- Copy the `xapp-…` token → this is `SLACK_APP_TOKEN`.

## 3. Install the app & grab the OAuth tokens
- **OAuth & Permissions** → **Install to Workspace** → authorize.
- Copy **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
- Copy **User OAuth Token** (`xoxp-…`) → `SLACK_WORKSPACE_TOKEN`.
  (This appears because the manifest declared `search:read.*` **user** scopes. RTS searches
  *as you*, so it must be a user token — not the bot token.)
- **Basic Information** → **App Credentials** → copy **Signing Secret** → `SLACK_SIGNING_SECRET`.

## 4. Create the private Ledger channel
- In Slack, create a **private** channel, e.g. `#decisions-ledger`. This is the agent's only
  datastore — every decision and profile is stored here as message metadata.
- Invite the bot: `/invite @decisionops`.
- Open the channel → channel name → **About** (scroll down) → copy the **Channel ID**
  (`C…`) → `LEDGER_CHANNEL_ID`.

## 5. Anthropic key
- <https://console.anthropic.com> → API key → `ANTHROPIC_API_KEY`.

## 6. Fill `.env`
```bash
cp .env.example .env
# edit .env with the six values from steps 2–5
npm install        # if you haven't already (installs dotenv too)
```

## 7. Preflight
```bash
npm run doctor
```
This pings every dependency and prints PASS/FAIL with a fix hint for each:
bot token, user token, Ledger channel (+ bot membership), Real-Time Search availability
(semantic vs keyword-first; catches `enterprise_is_restricted` / missing scopes), and the
Anthropic model. **Get this all-green before step 8.**

## 8. Run it
```bash
npm run dev
```
In a channel the bot is in, hover any message → **⋯ More actions** → **Capture decision**.
Expected: a **Canvas brief** is created, an **approval card** posts in-thread; clicking
**Approve** writes a `decisionops_record` (and a `decisionops_profile`) into the Ledger
channel and posts the final decision with owners.

## 9. See the memory win
Run **Capture decision** a second time on another message **in the same channel**. The agent
now has a warm profile for that channel, so it should perform **fewer Real-Time Search calls**
than the first (cold) capture — the cold-vs-warm thesis, live.

## Troubleshooting
- **`doctor` RTS check fails with `enterprise_is_restricted`** — you're calling RTS with an
  org/Grid token. Use a workspace-level user token. In a developer sandbox (a Grid org), the
  user token must be scoped to a single workspace within it.
- **RTS check fails with a missing-scope error** — reinstall after confirming the
  `search:read.*` user scopes are present (manifest step 1).
- **Semantic search shows `false`** — your plan/sandbox is keyword-only. That's fine; the
  agent is keyword-first by design. (Slack AI Search is a Business+/Enterprise feature; a
  sandbox can request it via the Slack Developer Program.)
- **Ledger check says "bot is not a member"** — `/invite @decisionops` to the Ledger channel.
- **Shortcut doesn't appear** — confirm Socket Mode is on and `npm run dev` is running; the
  shortcut `callback_id` must be `capture_decision` (it is, in the manifest).
