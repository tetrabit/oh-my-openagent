# Project Audit Report - QUEUED + Rate-Limit Regression

Date: 2026-02-25
Repository: `ohmyopencode-extension`

## Request

Investigate recurring runtime behavior:
- repeated `QUEUED` status updates
- followed by `This request would exceed your account's rate limit. Please try again later.`
- fallback/compaction recovery not stabilizing

Also provide a unification/quality review and compare with external best-practice patterns.

## Investigation method

- Parallel internal analysis (explore + direct grep/AST/read) over:
  - `runtime-fallback`
  - `anthropic-context-window-limit-recovery`
  - `preemptive-compaction`
  - `plugin` event/chat-message orchestration
- External parallel analysis (librarian) for queue/fallback state-machine best practices and OSS examples.
- Log correlation using `/tmp/oh-my-opencode.log` timeline patterns.

## Primary root cause (this iteration)

In runtime fallback awaiting mode, non-error assistant updates could clear fallback timeout too early:

1. `message.updated` (assistant, no error) path checked for any visible assistant response.
2. The check could succeed using stale previously completed assistant text.
3. Timeout/awaiting state got cleared before true fallback completion.
4. System then cycled through `QUEUED`/idle/rate-limit interactions without deterministic fallback advancement.

This is a state-ordering/guarding issue, not just parser matching.

## Fixes applied

### 1) Guard queued/pending statuses from clearing awaiting fallback

File:
- `oh-my-opencode/src/hooks/runtime-fallback/message-update-handler.ts`

Changes:
- In no-error assistant update path, `QUEUED`/`pending`/`processing`/`waiting` statuses now explicitly keep timeout armed.
- Added log branch for this state to improve traceability.

### 2) Prevent stale assistant message from clearing awaiting fallback

File:
- `oh-my-opencode/src/hooks/runtime-fallback/message-update-handler.ts`

Changes:
- `hasVisibleAssistantResponse` now requires current update `info.id` to match latest assistant message id before treating response as visible/final.
- This blocks stale-message visibility from prematurely ending fallback waiting.

### 3) Additional retryability hardening retained

Files:
- `oh-my-opencode/src/hooks/runtime-fallback/constants.ts`
- `oh-my-opencode/src/hooks/runtime-fallback/error-classifier.ts`

Retained behavior:
- Context-overflow/token-limit variants are classified as retryable fallback signals.

## Tests updated

File:
- `oh-my-opencode/src/hooks/runtime-fallback/index.test.ts`

Added/updated coverage:
- overflow errors trigger fallback in `session.error`
- overflow assistant errors trigger fallback in `message.updated`
- assistant-id mismatch while awaiting fallback keeps timeout armed, allowing next fallback progression

## Validation run

Executed in `oh-my-opencode`:

1. `bun test src/hooks/runtime-fallback/index.test.ts src/hooks/preemptive-compaction.test.ts src/plugin/chat-message.test.ts src/hooks/anthropic-context-window-limit-recovery/parser.test.ts src/hooks/anthropic-context-window-limit-recovery/recovery-hook.test.ts`
2. `bun run typecheck`
3. `bun run build`

Result: all passed.

## Codebase unification status

Current state: **improving but still race-sensitive**.

Strong points:
- Recovery concerns are modularized.
- Regression tests are expanding around real failures.

Remaining risks:
- Multiple state authorities (`session-model-state`, runtime fallback internals, compaction caches).
- Event-phase coupling (`session.error`, `message.updated`, `session.idle`) remains delicate.
- Overlapping fallback systems (legacy + runtime) increase branch complexity.

## External best-practice alignment (applied)

Patterns observed in mature OSS and orchestration state-machine designs:
- Treat `QUEUED` as intermediate/non-final, never success.
- Keep one authoritative in-flight/awaiting state per session.
- Use explicit timeout escalation and bounded advancement.
- Avoid stale visibility checks by correlating update ids.

This patch aligns directly with those patterns.

## Recommended next steps

P0:
- Add one integration test covering full chain: `QUEUED -> rate-limit -> fallback advance -> recovery success` in single session timeline.

P1:
- Centralize per-session transition state into one coordinator module (authoritative transition machine).

P2:
- Add structured hook telemetry fields (`transition`, `reason`, `sessionID`, `messageID`) for faster diagnosis.

## Addendum: latest 06:17 regression findings

Latest logs showed a different but related issue:

- Runtime fallback was active and dispatching retries.
- However, for session `ses_37a668c0cffeFf28bDNnyhN5R3`, fallback selection repeatedly logged:
  - `Using sisyphus fallback models (no agent detected)`
  - while also resolving `prometheus` context.

This indicated agent-key mismatch between canonical ids and decorated config keys (example: `prometheus` vs `Prometheus (Plan Builder)`), causing fallback chain selection to use generic sisyphus defaults instead of agent-specific chain.

### Additional fix applied

Files:
- `oh-my-opencode/src/hooks/runtime-fallback/fallback-models.ts`
- `oh-my-opencode/src/hooks/runtime-fallback/fallback-models.test.ts`

Behavior change:
- Fallback-model lookup now resolves configured agent keys using normalized matching (exact, case-insensitive, and canonicalized mapping), so decorated keys correctly map from runtime canonical ids.

Expected effect:
- Prometheus/other decorated agents now use intended fallback chains.
- Reduces fallback starvation loops caused by drifting to unintended generic fallback sequences.
