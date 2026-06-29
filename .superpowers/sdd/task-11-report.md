# Task 11 Report — Eval Harness

## What Was Built

Two files created verbatim from the brief:

- `eval/fakeSlack.ts` — in-memory Slack with:
  - `LedgerClient`: `chatPostMessage` unshifts to messages array (newest-first); `conversationsHistory` returns full array
  - `RtsClient`: `searchContext` increments a counter and returns a seeded result; `searchInfo` returns `semantic_search_enabled: false`
  - Exports `makeFakeSlack()` returning `{ ledgerClient, rts, searchCalls(), seedSearchResult(), raw }`

- `eval/harness.test.ts` — four assertions:
  - **(a)** Metadata round-trip: writes a `DecisionRecord` via `ledger.writeDecision`, reads it back with `ledger.allDecisions()`, asserts `toEqual` (byte-equivalent) and `isDecisionRecord(back) === true`
  - **(b)** Budget cap: calls `search.run()` 20 times against a `SearchBudget(6)`, asserts `fake.searchCalls() <= 6`
  - **(c)** Cold vs warm: cold run (`scriptedLlm(3)`) = 3 open questions → 3 RTS calls; warm run (`scriptedLlm(0)` + seeded profile) = 0 open questions → 0 RTS calls; asserts `warmRes.rtsCalls < coldRes.rtsCalls`
  - **(d)** Cursor advance: `consolidate()` with `newCursorTs: "1800"` overwrites the model's cursor output; asserts `prior.dynamic.searchCursor.untilTs === "0"` and `next.dynamic.searchCursor.untilTs === "1800"`

## Test Results

All 4 assertions passed in `eval/harness.test.ts`.

**Cold vs warm RTS counts (assertion c console.log):**
```
cold RTS calls=3  warm RTS calls=0
```

Full suite: **36 tests across 16 test files — all passed.**

## Type-Check

`npx tsc -p tsconfig.json --noEmit` — clean (zero errors, zero warnings).

## Files Changed

- `eval/fakeSlack.ts` (created, 22 lines)
- `eval/harness.test.ts` (created, 99 lines)

## Commit

`b54ad34` — `test: eval harness — metadata round-trip, budget cap, cold-vs-warm RTS, cursor advance`

## Concerns

None. The `scriptedLlm` phase counter (structuredPhase) correctly tracks resolve vs synthesize because each consumes one `output_config.format` call, and the gapcheck tool-loop turns are non-structured. The `consolidate` function is authoritative for the cursor (it ignores what the model returns for `searchCursor` and uses `newCursorTs` directly), so assertion (d) is robust.

## Fix: cold>0 assertion

Added explicit `expect(coldRes.rtsCalls).toBeGreaterThan(0);` on line 76 of `eval/harness.test.ts` (placed before the existing `toBeLessThan` assertion) to self-document the proof and catch regressions that zero the cold path.

**Command:** `npx vitest run eval/harness.test.ts`

**Result:**
```
✓ eval/harness.test.ts (4 tests) 3ms
cold RTS calls=3  warm RTS calls=0
Tests  4 passed (4)
```

Full suite: **16 test files, 36 tests — all passed.**

## Final-review fixes

Applied from whole-branch review before merge.

### I-1 (demo-blocking) — reorder mid-conversation system message

**Files:** `src/agent/gapcheck.ts`, `src/agent/synthesize.ts`

In both files, the `messages` array was reordered so the `role:"user"` message comes FIRST and `dynamicSystemMessage(a.dynamicProfile)` is LAST. The Anthropic API rejects `role:"system"` at `messages[0]`; it must follow a user turn.

**Regression guards added:**
- `test/agent/gapcheck.test.ts` — asserts `firstCall.messages[0].role` is not `"system"` and that `rts.searchContext` received `{ after: "0" }`.
- `test/agent/synthesize.test.ts` — asserts `firstCall.messages[0].role` is not `"system"`.

### M-2 (memory integrity) — reject must not consolidate into profile

**File:** `src/app.ts`

The `consolidate` + `ledger.writeProfile` block in `finalize()` is now gated behind `if (status === "decided")`. `ledger.writeDecision(record)` still runs for both statuses (audit trail). A rejected decision no longer advances the delta cursor or teaches the entity profile.

### M-1 (idempotency) — claim pending entry on entry

**File:** `src/app.ts`

`pending.delete(decisionId)` is now called immediately after `if (!p) return`, before any async work. A second click on approve/reject finds nothing and returns early. The trailing delete was removed (now redundant).

### Recommended — guard JSON.parse in `structured()`

**File:** `src/agent/llm.ts`

Wrapped `JSON.parse(firstText(res.content))` in a try/catch that throws a descriptive error including the char count, instead of an opaque `SyntaxError`.

### Recommended — assert afterTs forwarded in gapcheck test

**File:** `test/agent/gapcheck.test.ts`

Added `expect(rts.searchContext).toHaveBeenCalledWith(expect.objectContaining({ after: "0" }))` to verify `afterTs` is forwarded as `after` to the RTS client.

### Test command and result

```
npx vitest run
```
```
Test Files  16 passed (16)
     Tests  36 passed (36)
  Duration  458ms
```

`npx tsc -p tsconfig.json --noEmit` — clean (zero errors).

### Commit

`fix: reorder mid-conv system message, gate observer on decided, idempotent finalize, guard JSON.parse`
