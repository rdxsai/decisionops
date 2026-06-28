# DecisionOps Agent — Design Spec

**Date:** 2026-06-28
**Status:** Draft for review
**Scope:** v1 (capture-flow first) + the eval/test harness that proves the memory claim

---

## 1. Summary & wedge

DecisionOps is a Slack-native AI agent that turns a discussion thread into a **captured, approved, and remembered decision**. A human invokes it on a specific message ("Capture decision"); it gathers just-enough context, drafts a decision brief in a Canvas, routes approval with buttons, posts the final decision with follow-up owners, and **remembers** what it learned so the next decision in that area is cheaper and richer.

**The wedge:** decisions get made in Slack and then evaporate — three months later nobody can reconstruct *why*. The differentiated bet is **incremental, persistent memory**: the agent does not rebuild context from scratch every time. It searches extensively once per area, consolidates that into reusable profiles, and afterward only searches the *delta*.

**The moat is the memory model, not the capture flow.** The capture flow is table stakes done well; the memory is what a *Best Technological Implementation* judge remembers.

---

## 2. Track & app classification (working assumptions — confirm in review)

- **Track:** New Slack Agent. (Implied by the choice to keep the app internal/custom, which is incompatible with the Organizations track's Marketplace-submission requirement. Switching to Organizations later is a distribution-layer change, not an architecture change.)
- **App type:** Internal / custom app, single workspace. This is required for performance — internal apps are **exempt** from the May-2025 `conversations.history` throttle (distributed non-Marketplace apps drop to 1 req/min × 15 objects; internal keep ~50+/min × 1000 objects), and our memory reads depend on `conversations.history`.
- **Compute:** Self-hosted (serverless function or small always-on host). **Fully-Slack-hosted compute is not possible for this agent type** — `slack create agent` scaffolds a self-hosted Bolt app; Slack's hosted runtime (ROSI) only runs the legacy Deno platform, which lacks the agent framework + RTS. **The honest framing: zero external *data* (no DB/vector store/object store — Slack is the entire backend), but compute runs on a host.**
- **Stack default:** Bolt for JavaScript/TypeScript + Claude Agent SDK (latest Claude model). Easily switchable to Bolt Python; flag in review.

---

## 3. Architecture overview

Two loops share one Slack-native store.

```
╔══════════════════════════════════════════════════════════════════════════╗
║                     SLACK-NATIVE STATE  (no external DB)                   ║
║   LEDGER = one private channel. Each message carries metadata JSON:        ║
║     • decision_record   (one per captured decision)                        ║
║     • entity_profile    (one per channel/project: static + dynamic)        ║
║   Read back via conversations.history?include_all_metadata=true           ║
╚════════════▲═══════════════════════════════════════════════▲═════════════╝
   read (free)│ push profiles                          write  │ records+profiles
              │                                               │
   CAPTURE LOOP — FOREGROUND (user waiting)      OBSERVER LOOP — BACKGROUND
```

- **Capture loop (foreground):** what the human triggers and waits on. Deliberately thin. Mostly free Ledger reads + LLM, a budgeted RTS search only for gaps, then render → approve → finalize.
- **Observer loop (background / off the hot path):** the **heavy summarization**. Consolidates decisions + recent activity into entity profiles. Never blocks the user.
- **Ledger:** the seam between them. All state is Slack message metadata. No external database.

---

## 4. The capture pipeline (foreground, steps 1–10) + observer (step 11)

| # | Step | Lane | Primitive | Cost | Notes |
|---|------|------|-----------|------|-------|
| 1 | **Trigger** | FG | `message_action` shortcut | — | "Capture decision" on a message → `{channel, message, response_url}` |
| 2 | **Hydrate** | FG | `conversations.replies` | cheap | full thread text |
| 3 | **Resolve** | FG | LLM | no API | decision statement? options? `entities=[channel, project, people]` |
| 4 | **Recall** | FG | Ledger read | **free** | PUSH static+dynamic profile into context. Cold path → build inline (see §5/§7) |
| 5 | **Gap-check** | FG | LLM | no API | "what's still missing for the brief?" over pushed context |
| 6 | **Pull** | FG | `assistant.search.context` (RTS) | **budget ≤6** | user-scoped; delta only (after `profile.cursor`); keyword-first, semantic if available |
| 7 | **Synthesize** | FG | LLM | no API | *light, per-decision* summary → brief + body text |
| 8 | **Brief** | FG | `canvases.create` | write | living Canvas; post in-thread + ask open questions |
| 9 | **Approve** | FG | Block Kit `block_actions` | write | Approve / Revise / Reject. Card via `chat.postMessage` (not mid-stream — see §8) |
| 10 | **Finalize** | FG | `canvases.edit` + post | write | status=Decided; post decision + @owners with follow-ups; write `decision_record` to Ledger |
| 11 | **Consolidate** | BG | history read + LLM + metadata write | heavy, off hot path | fold decision + recent threads into `entity_profile`; refresh dynamic, rewrite static on drift; advance cursor |

**Two invariants:** search is **step 6, not step 1** (profiles absorb most context for free), and **all retrieval is user-scoped** with provenance-only storage (§7).

---

## 5. Memory model

**Substrate decision:** datastores are locked to Slack-hosted apps (unavailable to us); a Canvas **cannot be read back** via the Web API (write-only from our side). Therefore the machine-readable store is **message metadata** — arbitrary JSON attached to a posted message, read back via `conversations.history?include_all_metadata=true`.

**The Ledger = one dedicated private channel.** Each captured decision and each entity profile is one message there, carrying its JSON in metadata. The message *body* is an LLM-written human-skimmable summary (so the channel is browsable); the *metadata* is the machine truth. **The agent reads metadata, never parses body prose.**

### 5.1 `decision_record` schema

```json
{
  "record_type": "decision_record",
  "id", "title", "status",
  "origin": {"channel_id", "thread_ts"},
  "capturer", "approvers", "decided_at",
  "decision_text", "options_considered", "rationale",
  "owners": [{"user_id", "task", "due"}],
  "entities": ["project-atlas", "U123", "billing"],
  "related_decision_ids": [...],
  "context_refs": [{"permalink", "channel_id", "ts", "snippet"}],
  "canvas_id"
}
```

### 5.2 `entity_profile` schema (static + dynamic)

Modeled on harness-level memory (Dhravya, *Memory on the harness level*): **static injected once & prompt-cached; dynamic injected every turn; both maintained by an observer off the hot path.** "Per turn" describes *injection*, not *creation* — the observer writes asynchronously; the foreground pushes whatever was last cached.

```json
{
  "record_type": "entity_profile",
  "entity_id": "project-atlas",
  "static": {                              // built once, rewritten rarely (drift only)
    "summary": "Billing-migration workstream; goal = retire legacy invoicing",
    "key_people": ["U123", "U456"],
    "key_systems": ["postgres", "stripe"],
    "decision_norms": "Needs eng-lead + finance sign-off",
    "built_at": "..."
  },
  "dynamic": {                             // refreshed from the delta
    "in_flight_decisions": ["dec_88", "dec_91"],
    "recent_threads": [{"permalink", "snippet", "ts"}],
    "open_questions": ["Do we dual-write during cutover?"],
    "search_cursor": {"until_ts": "173..."},   // the delta pointer lives HERE
    "refreshed_at": "..."
  }
}
```

**Design rules:**
- **Memory keyed by entity/topic (never time-filtered); the RTS delta keyed by time (efficiency only).** A new decision about Project X pulls *all* of X's prior ledger context regardless of age, then delta-searches the live workspace only since X's cursor. This avoids the "global clock misses old-but-relevant context" failure mode.
- **Profiles are views, not archives.** Static = a paragraph + a few lists; dynamic = the delta only. Old items age out into `decision_record`s (the durable facts). Keep profiles small enough to inject every turn and stable enough to prompt-cache.
- **Who does what:** the **observer** owns all heavy/reusable summarization; the **foreground** only does light per-decision synthesis (step 7). The single exception is the **cold-start inline build** (step 4) when no profile exists yet.

---

## 6. Retrieval model

**Bounded query-planning from a seed**, with a hard budget (Slack guidance: <10 RTS calls/inquiry; we target **≤6**, respecting the per-user 10/min cap).

1. **Seed** (no cost): the invoked thread — channel, participants, mentions, links.
2. **Recall** (free): pull entity profiles from the Ledger → warm start.
3. **Gap-check** (LLM): what does the brief still need that the profile doesn't cover?
4. **Pull** (budgeted RTS): one targeted query per gap.
   - **Keyword-first; semantic as enhancement.** Detect availability via `assistant.search.info`; semantic triggers on natural-language `?` queries when Slack AI Search is enabled, else keyword (stemming). The agent must produce good briefs in **keyword-only** mode (the demo sandbox may lack semantic).
   - **Delta-scoped:** `after: profile.dynamic.search_cursor.until_ts`.
   - **User-scoped** (§7).
5. **Stop** when brief fields are filled or budget hit; **cache** `context_refs` + advance cursor (in v1, on finalize; phase-2, in the observer).

**Cold entity** (no profile) → bounded full search. **Warm entity** → profile + delta only. This is what makes captures progressively cheaper, and it's the metric we measure (§9).

---

## 7. Permissions & the laundering trap

**Search as the user.** RTS `assistant.search.context` runs on behalf of the authenticated user and returns **only content that user can access** — private channels they're not in are invisible, enforced server-side. Private scope needs a **user token** (`xoxp-`) with granular `search:read.*`; a bot token sees public-only and needs a per-event `action_token`. The agent is an extension of the invoker, never a privileged crawler.

**Searching as the user is necessary but not sufficient — the laundering trap.** The agent *persists* what it finds into a Canvas brief and a Ledger that **other people read**. User A (in `#exec-private`) captures a decision; the brief pastes `#exec-private` context; approver User B — not in that channel — opens the brief and sees content Slack would never have shown them. Mitigations, in priority order:

1. **Store provenance, not payload.** Ledger + brief hold permalinks + minimal snippets; the brief *links* to sources rather than pasting them, so Slack's unfurl enforces the *viewer's* permissions at read time.
2. **Audience-scope the brief.** Tag each context ref with its source channel's visibility; inline only content at least as open as the brief's audience; everything narrower becomes a permission-gated link.
3. **Treat the Ledger channel as privileged.** Its membership *is* an access-control boundary.

**Profiles inherit this risk.** A `static.summary` consolidating a private channel, pushed into a brief an outsider reads, leaks the same way. So the observer only consolidates from channels it's legitimately in, and audience-scoping applies to profile content too.

**RTS call constraint:** `assistant.search.context` returns `enterprise_is_restricted` for org-level (Grid) tokens — **call it with a workspace-level token**, not an org token. Relevant in the sandbox (a Grid org).

---

## 8. Platform constraints that pin the design (verified)

| Constraint | Implication |
|------------|-------------|
| No Slack-hosted compute for Bolt agents (ROSI = legacy Deno only) | Self-host on serverless; "Slack-native data," not "Slack-native compute" |
| Datastores locked to Slack-hosted apps | Use **message metadata** as the state store |
| Canvas has no Web API read-back | Canvas is **write-mostly**; authoritative state lives in metadata, rendered to Canvas |
| `conversations.history` 2025 throttle exempts internal apps | **Keep app internal/custom** |
| RTS `enterprise_is_restricted` on org tokens | Call RTS with a **workspace token** |
| Semantic RTS gated to Slack-AI plans; indexing is batch ("offline jobs") | **Keyword-first** design; detect via `assistant.search.info`; tolerate indexing latency |
| Streaming: interactive blocks only attach on `chat.stopStream` | Post the **approval card via `chat.postMessage`**, not mid-stream |
| RTS rate limit: special tier, per-user 10/min, <10 calls/inquiry | Budget **≤6 RTS calls/capture**; profiles absorb the rest |

---

## 9. Eval & test harness (first-class — it proves the thesis)

Memory quality is invisible on an empty sandbox and unmeasurable without ground truth. The harness needs **volume + realism** and an **answer key**.

### 9.1 Environment split (forced by platform facts)

- **Eval workspace** = a **non-Grid** Free/Pro/Business+ workspace (your own) where you can **import backdated heavy history** (CSV/text import takes a Unix-epoch column; or Slack-to-Slack workspace import) and, on Business+, get semantic search. This is where you **measure**.
- **Demo sandbox** = the required Developer Program sandbox (a Grid org). **Cannot be imported into** → API-seed now-dated synthetic data (the sandbox template ships 7 users/7 channels as a base). Used for the judge-facing demo + the required access grant to `slackhack@salesforce.com` and `testing@devpost.com`. Request an **AI-enabled sandbox** via Slack partnerships if semantic is wanted there.
- Backdating is only needed to make the demo *look* aged; **delta logic is measured by setting the cursor to a midpoint** of now-dated data, so it doesn't require backdating.

### 9.2 Three test layers

1. **Logic (CI, no heavy data):** delta-cursor correctness; profile read/write round-trip through metadata; permission-scoping with mocked RTS; **≤6-call budget enforcement**. Deterministic.
2. **Retrieval quality (the heavy-workflow eval):** a seeded workspace with **planted relationships** (e.g., "D7 should recall D2, D4; needs T1, T3") → built-in answer key. Measure:
   - **Recall / precision** of surfaced context vs planted ground truth.
   - **Brief quality** via LLM judge against the answer key + human spot-checks.
   - **Cold-vs-warm RTS-call count** — capture #1 (cold) vs capture #2 same entity (warm). *This single chart quantifies the entire thesis.*
   - **Delta correctness** — cursor at a midpoint; confirm live results are after-cursor only and pre-cursor context comes from profile/ledger, not re-search.
3. **Real workspace (optional, private):** internal app installed in your own community/company Slack with genuine heavy history; eyeball quality; keep that workspace private and demo on the sandbox.

### 9.3 Data sourcing

- **Seed:** `houstondatavis/slack-export` (MIT, native export format) for the import path; the MSR "disentangled Slack conversations" corpus (XML, research-only) converted to export JSON / epoch-CSV for heavier volume.
- **Ground truth:** **planted synthetic decisions** layered on top, so recall/precision are measurable.
- **Live seeding (sandbox):** one bot token + `chat:write.customize` for multi-persona cosmetics, paced ~1 msg/sec/channel, parallelized across channels.

### 9.4 Indexing-latency probe

Slack does not document whether/when AI search indexes seeded/imported data. Build a **sentinel probe**: post a known string, poll `assistant.search.context` until it appears, measure the lag. The eval must never run against an unindexed workspace. Also verify imported-vs-native indexing parity empirically.

---

## 10. v1 scope vs phase-2

**In v1 (capture-flow first, with a read-through profile cache):**
- Message-shortcut trigger; pipeline steps 1–10.
- Ledger (decision_record + entity_profile) on message metadata.
- **Observer runs inline** — cold-start build (step 4) and update-on-finalize (step 11). No separate always-on watcher.
- Keyword-first retrieval with semantic enhancement when available; ≤6-call budget; per-entity delta cursor.
- Canvas brief; Block Kit approval; finalize with owners.
- Permission discipline (search-as-user, provenance-not-payload, audience-scoped, privileged Ledger).
- Eval harness: logic layer + retrieval-quality layer on the eval workspace + the cold-vs-warm metric.

**Deferred to phase-2:**
- **Async/event-driven observer** watching opted-in channels (so even capture #1 is warm).
- **Proactive nudge** ("this thread looks like a decision — capture it?") in opted-in channels.
- Slash-command surface; assistant-container conversational surface.
- Marketplace submission (only if pivoting to the Organizations track).

---

## 11. Open assumptions & risks

- **Assumptions to confirm in review:** track = New Slack Agent; stack = Bolt JS/TS + Claude Agent SDK; internal/custom app; self-hosted compute accepted.
- **Top risk — semantic indexing of seeded data is undocumented/batch-delayed.** Mitigated by keyword-first design + the sentinel probe, but validate early.
- **Sandbox can't import** → demo history is now-dated; mitigated by cursor-midpoint testing and the two-environment split.
- **RTS workspace-token requirement** in the Grid sandbox — wire token selection accordingly.
- **Item-size quotas for message metadata are unpublished** — keep profiles small (also required for prompt-caching).

---

## 12. Next step

On approval of this spec → **writing-plans** to produce the v1 implementation plan (project scaffold, Ledger module, retrieval module, capture handler, Canvas/approval UI, observer, eval harness), sequenced for the hackathon timeline.
