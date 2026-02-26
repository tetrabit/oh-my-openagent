# Project Audit Report - Overflow Recovery and Cohesion

Date: 2026-02-25
Repo: `ohmyopencode-extension`

## What was investigated

- Regressed runtime behavior: `prompt token count of 201594 exceeds the limit of 128000` followed by `QUEUED`/recovery stall.
- Compaction + fallback interactions across:
  - `anthropic-context-window-limit-recovery`
  - `runtime-fallback`
  - `preemptive-compaction`
  - shared session model state publication (`session-model-state`)
- Codebase cohesion and maintainability in `oh-my-opencode` + merged `opencode-platform` workspace.
- External best-practice patterns from official docs and OSS implementations.

## Root-cause findings

1. The overflow parser already supports this format.
- `parser.ts` and tests already handle `prompt token count of X exceeds the limit of Y`.

2. Runtime fallback was not treating overflow as retryable.
- `ContextOverflowError` and related overflow message variants were not explicitly classified as retryable.
- Result: runtime fallback skipped model switching for overflow while compaction kept attempting recovery.

3. Compaction model-target selection had stale-state windows.
- `preemptive-compaction` could rely on cached last-assistant model (old exhausted model) when fallback had already switched intent/model state.

## Changes implemented in this pass

### Runtime fallback overflow classification

Updated:
- `oh-my-opencode/src/hooks/runtime-fallback/constants.ts`
- `oh-my-opencode/src/hooks/runtime-fallback/error-classifier.ts`

Added retryable handling for overflow-related variants:
- `ContextOverflowError`
- `prompt token count of ... exceeds the limit of ...`
- `prompt is too long`
- `model_max_prompt_tokens_exceeded`
- `token limit exceeded`

### Fallback/compaction state alignment

Previously patched and retained:
- `oh-my-opencode/src/plugin/chat-message.ts` now writes shared session model after runtime fallback output override.
- `oh-my-opencode/src/hooks/preemptive-compaction.ts` now prefers `getSessionModel(sessionID)` over stale cached model when selecting compaction target.

## Test updates

Updated:
- `oh-my-opencode/src/hooks/runtime-fallback/index.test.ts`

Added coverage for overflow-based retryability:
- `session.error` with `ContextOverflowError` triggers fallback preparation.
- `message.updated` assistant overflow error triggers fallback preparation.

## Verification executed

In `oh-my-opencode`:

1. `bun test src/hooks/runtime-fallback/index.test.ts src/hooks/preemptive-compaction.test.ts src/plugin/chat-message.test.ts src/hooks/anthropic-context-window-limit-recovery/parser.test.ts src/hooks/anthropic-context-window-limit-recovery/recovery-hook.test.ts`
2. `bun run typecheck`
3. `bun run build`

Result: all passing.

## Codebase unification assessment

Current status: **moderately unified, still race-sensitive**.

Strengths:
- Better modularity of hooks and focused tests.
- Strong iterative verification discipline.

Remaining cohesion risks:
- Model state authority still split across multiple hooks and event phases.
- Event ordering dependency remains subtle (`session.error` / `message.updated` / `session.idle`).
- Repeated logic around model/provider resolution appears in multiple modules.

## Recommended next steps (priority)

P0:
- Introduce one authoritative per-session model-state coordinator used by fallback + compaction + preemptive compaction.
- Add integration test: exhausted model + overflow + fallback + compaction in one scenario.

P1:
- Add structured lifecycle telemetry for each hook phase (`start`, `decision`, `state write`, `end`).
- Add per-session idempotency guard around compaction-triggered reruns.

P2:
- Consolidate provider/model parsing utilities to reduce drift.
- Add contract tests for event payload shapes used in runtime tests.

## External best-practice alignment

Observed patterns from official docs and mature OSS implementations:
- Classify terminal vs transient failures explicitly before retry.
- Use bounded retries and cooldown/circuit-breaker semantics.
- Publish authoritative state before downstream recovery stages consume it.
- Prefer deterministic event ordering and idempotent transitions.

This pass moved the project closer to those patterns by making overflow conditions fallback-eligible and reducing stale model selection during compaction.
