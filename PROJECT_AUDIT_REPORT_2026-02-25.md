# Project Unification and Reliability Audit

Date: 2026-02-25
Repository: `ohmyopencode-extension`

## Scope and method

This audit combined:
- Internal exhaustive search across `opencode-platform` and `oh-my-opencode` (parallel explore agents + direct grep/AST reads).
- External research for best practices and OSS implementation patterns (parallel librarian agents + web/GitHub searches).
- Targeted regression diagnosis and code verification for the active bug: compaction running on an exhausted model.

## Executive assessment

Overall unification status: **moderate, improving**.

Strengths:
- Good test/build discipline and repeatable local install/revert scripts.
- Runtime fallback and compaction systems already have clear modular boundaries.
- Prior fixes (retry caps, no-retry account-limit handling, UI model sync) are still in place.

Primary risks:
- Model selection authority is split across multiple hooks/paths.
- Event-order and shared-state timing can still create race windows.
- Some event test fixtures are drifting from stricter runtime event typings.

## Regression reproduced/triaged in this session

Observed symptom:
- In legacy `model_fallback` mode, when usage is exhausted and compaction is triggered, compaction can target the exhausted model instead of the next fallback model.

Root cause:
- `session.error` handling in legacy fallback armed pending fallback **after** dispatch flow, but did not publish the upcoming fallback model to shared session model state.
- Compaction resolver uses shared session model state first; stale state could still point to exhausted model.

## Changes made

### 1) Added non-consuming fallback peek API

File: `oh-my-opencode/src/hooks/model-fallback/hook.ts`

- Added `FallbackSelection` type.
- Added `peekNextPendingFallback(sessionID)` to inspect next fallback without consuming fallback progression.
- Refactored fallback resolution into shared `resolveFallback(..., consume)` logic to keep behavior consistent between peek and consume paths.

### 2) Publish next fallback model immediately when legacy fallback is armed

File: `oh-my-opencode/src/plugin/event.ts`

- In legacy fallback branches (`message.updated`, `session.status`, `session.error`), after `setPendingModelFallback(...)` succeeds:
  - Call `peekNextPendingFallback(sessionID)`.
  - If a fallback exists, call `setSessionModel(sessionID, { providerID, modelID })`.

Impact:
- Compaction now sees the upcoming fallback model in shared state before it executes.

### 3) Added regression tests for peek semantics and legacy session.error sync

Files:
- `oh-my-opencode/src/hooks/model-fallback/hook.test.ts`
- `oh-my-opencode/src/plugin/event.model-fallback.test.ts`

New coverage:
- `peekNextPendingFallback` does not consume attempt progression.
- Legacy `session.error` fallback arming updates shared session model to the upcoming fallback model.

## Verification run

Executed in `oh-my-opencode`:

1. `bun test src/hooks/model-fallback/hook.test.ts src/plugin/event.model-fallback.test.ts src/hooks/anthropic-context-window-limit-recovery/recovery-hook.test.ts`
2. `bun run typecheck`
3. `bun run build`

Result: **all passed**.

LSP note:
- Core edited runtime files (`event.ts`, `hook.ts`) are clean.
- `event.model-fallback.test.ts` reports IDE/LSP type drift errors that are not failing project typecheck/build (existing fixture-vs-runtime event typing mismatch area).

## External best-practice references

Authoritative docs used for policy alignment:
- Anthropic rate limits: `https://platform.claude.com/docs/en/api/rate-limits`
- Anthropic errors: `https://platform.claude.com/docs/en/api/errors`
- OpenAI 429 handling: `https://help.openai.com/en/articles/5955604`
- OpenAI rate-limit best practices: `https://help.openai.com/en/articles/6891753-what-are-the-best-practices-for-managing-my-rate-limits-in-the-api`
- OpenAI cookbook backoff examples: `https://developers.openai.com/cookbook/examples/how_to_handle_rate_limits/`

Observed OSS pattern worth mirroring:
- Typed, normalized error mapping before retry/fallback decisions (example family: Vercel AI gateway error taxonomy).

## Recommendations (prioritized)

### P0 (near-term)
- Define a single model-selection authority contract used by fallback + compaction + retry.
- Add one integration test that exercises: exhausted model -> fallback armed -> compaction -> rerun, across both runtime and legacy fallback modes.

### P1
- Introduce structured hook lifecycle telemetry per event path (`event`, `hook`, `duration_ms`, `sessionID`, selected model).
- Reduce event payload shape drift in tests by introducing typed fixture builders.

### P2
- Normalize naming consistency (`sessionID` / `sessionId`) and shared state adapters.
- Cache immutable config reads per session lifecycle where repeated parsing occurs.

## Current conclusion

The immediate regression is fixed in code and validated. The codebase is reasonably cohesive but still exposed to cross-hook race regressions until model-selection authority and integration-level ordering tests are unified further.
