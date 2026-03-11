# OpenCode Subagent Fallback Cleanup Fix Plan

Date: 2026-03-10
Target codebase: `/root/projects/opencode/oh-my-openagent/oh-my-opencode`

## Goal

When a background subagent fails over to another provider/model, the superseded request must be:

1. dequeued from local management
2. actively ended
3. kept under cleanup supervision until termination is confirmed
4. prevented from later notifying the parent session or continuing hidden model work

This must not interfere with the replacement fallback request.

## Non-Goals

- Redesigning all of OpenCode session lifecycle semantics
- Removing fallback behavior
- Changing the user's configured provider order
- Solving unrelated main-agent runtime-fallback behavior in the same patch set

## Root Problems To Fix

### Current behavior

Today the fallback path:

1. calls `session.abort` on the current subagent session
2. immediately clears `task.sessionID`
3. requeues the task on a new model/provider
4. forgets the old session locally

This is implemented in:

- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/fallback-retry-handler.ts:83-104`

### Why this is unsafe

- abort is asynchronous and not confirmed
- the old session can still emit events after fallback
- the manager no longer owns the old session, so it cannot reap it cleanly
- `retry` sessions are treated as still running and can persist for a long time

## Implementation Plan

## Phase 1: Add Retired Session Tracking

Introduce a dedicated registry for superseded sessions, for example:

- `retiredSessionsBySessionID: Map<string, RetiredSessionRecord>`

Suggested record fields:

- `sessionID`
- `taskID`
- `parentSessionID`
- `agent`
- `replacedAt`
- `replacementAttempt`
- `replacementModel`
- `abortRequestedAt`
- `lastObservedStatus`
- `lastObservedActivityAt`
- `cleanupState`

Expected behavior:

- on fallback, do not simply forget the old session
- move it into the retired-session registry
- keep enough metadata to keep reaping it until termination is confirmed

Primary files:

- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts`
- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/fallback-retry-handler.ts`

## Phase 2: Make Fallback Two-Phase

Change fallback from "abort then forget" to "retire then replace".

New sequence:

1. mark current session as retired
2. request `session.abort`
3. preserve retired-session tracking
4. requeue replacement task
5. only remove retired session state after terminal confirmation

Important detail:

- the replacement fallback request should still start immediately
- the old session should remain under supervision in parallel

This preserves current responsiveness while fixing cleanup correctness.

## Phase 3: Handle Events For Retired Sessions

Extend event handling so retired sessions are still recognized even after the main task has moved on.

Events to handle:

- `session.status`
- `session.error`
- `session.idle`
- `session.deleted`
- `message.updated`
- `message.part.updated`
- `message.part.delta`

Required behavior:

- if a retired session emits new activity after `abortRequestedAt`, log it as leaked activity
- do not allow retired-session output to notify the parent as active task progress
- if a retired session reaches `idle`, `error`, or `deleted`, remove it from the retired registry
- if a retired session continues producing activity, issue another abort

This is the core protection against "hours later it wakes back up and sends context".

## Phase 4: Add Retired Session Reap Timers

Add explicit cleanup timers for retired sessions.

Suggested policy:

- short grace window after first abort request
- if still `busy` or `retry`, re-abort
- if still alive after a longer retirement timeout, mark as leaked and surface a warning

Suggested states:

- `retiring`
- `re-aborting`
- `terminated`
- `leaked`

This should be separate from normal task staleness, because the session is no longer the active task.

## Phase 5: Tighten `retry` Handling For Active Background Sessions

The active background task path should not let `retry` persist forever without progress.

Required changes:

- keep the recent `SessionRetry` retryability fix
- add a retry-without-progress timeout for active background sessions
- if a running session stays in `retry` with no tool/message progress beyond the grace period, advance to the next fallback

Primary file:

- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/task-poller.ts`

The key distinction:

- `retry` should not be treated as permanently healthy running work

## Phase 6: Prevent Orphaned Parent Notifications

Ensure retired sessions can never later bubble output into parent notifications.

Checks to add:

- `notifyParentSession` should only operate on the currently active session for the task
- retired sessions must be ignored for completion notifications
- any message aggregation / pending notification path should reject retired session IDs

This prevents stale sessions from later dumping context or results into the visible parent thread.

## Phase 7: Improve Observability

Add structured logs for:

- fallback retirement start
- abort request sent
- post-retirement activity observed
- retired session termination confirmed
- retired session leak timeout reached
- retry-without-progress escalation

This will make future bandwidth incidents diagnosable from logs alone.

## Test Plan

## Unit Tests

Add tests for:

- fallback retains old session in retired registry
- replacement task starts immediately
- old session `session.error` cleans up retired entry
- old session `session.deleted` cleans up retired entry
- old session emits `message.updated` after retirement and gets re-aborted
- retired sessions do not notify parent
- active session stuck in `retry` with no progress advances to next fallback

Likely files:

- `src/features/background-agent/manager.test.ts`
- `src/features/background-agent/fallback-retry-handler.test.ts`
- new dedicated test file if the retired-session logic is extracted

## Integration / Behavior Tests

Simulate:

1. Claude session rate-limits
2. fallback to OpenCode-hosted model starts
3. original session keeps emitting events after abort
4. manager suppresses old output and reaps old session
5. replacement session continues normally

Also simulate:

1. fallback session enters `retry`
2. no progress occurs
3. manager advances again instead of waiting indefinitely

## Soak Test

Run a long-lived session with intentionally exhausted provider access and verify:

- no retired session remains active past the retirement timeout
- no stale background task remains in `retry` forever
- outbound traffic drops once the active fallback chain is exhausted or settled

## Rollout Order

1. Implement retired-session registry and event handling
2. Implement retry-without-progress timeout
3. Add tests
4. Validate against a real exhausted-subscription scenario
5. Patch live installed bundle only after source tests pass

## Acceptance Criteria

The fix is complete when all of the following are true:

- a fallback no longer causes the previous session to become untracked immediately
- a superseded session is reaped or repeatedly aborted until terminal state is confirmed
- retired sessions cannot later produce parent-visible results
- `retry` sessions without progress do not persist indefinitely
- leaving an OpenCode pane open for hours does not result in orphaned background subagents continuing hosted inference unnoticed

## Immediate First Patch Recommendation

If the fix is split into smaller commits, the first safe patch should be:

1. add retired-session tracking
2. stop clearing local ownership of the old session until it is retired into that registry
3. handle retired-session terminal events

That closes the biggest correctness gap without requiring a full redesign of polling logic in the same commit.
