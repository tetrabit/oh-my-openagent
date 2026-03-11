# OpenCode Subagent Fallback Follow-up Code Review

Date: 2026-03-10
Related report: `/root/opencode-bandwidth-investigation-2026-03-09.md`
Primary codebase reviewed: `/root/projects/opencode/oh-my-openagent/oh-my-opencode`

## Executive Summary

The previous bandwidth investigation was directionally correct: the spike is consistent with active hosted inference from old background subagent sessions, not passive telemetry alone.

The code review adds a more precise root cause:

1. Background subagent fallback attempts do not prove the original session has actually stopped.
2. The fallback path severs local ownership of the original session immediately after sending `session.abort`.
3. If the original session ignores, delays, or outlives that abort, it can continue running untracked.
4. A long-lived untracked session is a credible explanation for later network activity from an apparently idle pane.

The previous report established that old subagent sessions were still generating hosted-provider messages. The code review establishes a concrete mechanism by which superseded sessions can survive fallback and continue doing work.

## What The Previous Report Got Right

The earlier report is well-supported on these points:

- The bandwidth-heavy process was `opencode`, not the shell.
- The visible pane could appear idle while background OpenCode activity continued.
- Old `koreader` session-family subagents were still active or retrying.
- Fresh DB activity under `providerID = "opencode"` is consistent with live hosted inference.
- The evidence supports "active model work" much better than "telemetry only".

These claims are consistent with both the runtime logs and the background-agent code.

## What The Code Review Now Proves

### 1. Fallback does not confirm shutdown of the original subagent

In `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/fallback-retry-handler.ts:83-104`, the old session is only aborted asynchronously:

- `client.session.abort({ path: { id: task.sessionID } }).catch(() => {})`

Immediately after that, the task is rebound to the fallback attempt:

- `task.status = "pending"`
- `task.sessionID = undefined`
- `task.startedAt = undefined`

That means the manager stops treating the original session as the live task before there is any proof that the old session actually died.

### 2. Once fallback starts, the old session becomes unowned

Event handling for background tasks resolves the current task through `findBySession(sessionID)`:

- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:785-795`
- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:845-853`
- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:961-966`

After fallback, `task.sessionID` no longer points at the original session, so later events from that old session no longer map back to the task.

The wrapper also deletes the old session from the local `subagentSessions` set as soon as fallback is accepted:

- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:975-988`

That is local bookkeeping only. It does not prove the remote session stopped.

### 3. A missed fallback can leave a session in `retry` indefinitely

The polling loop explicitly treats `session.status = "retry"` as still running:

- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:1578-1585`

The stale-task watchdog does not interrupt any non-`idle` session:

- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/task-poller.ts:83-89`
- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/task-poller.ts:112-118`

So if fallback does not advance cleanly, the session can sit in `retry` for a long time without being reaped by the normal stale logic.

### 4. Cleanup paths are mostly in-memory cleanup, not confirmed remote teardown

When tasks error, complete, or are cancelled, the manager usually:

- removes the task from memory
- removes notification state
- removes local session bookkeeping
- sends `session.abort` fire-and-forget

Examples:

- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:448-455`
- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:740-749`
- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:1148-1153`
- `/root/projects/opencode/oh-my-openagent/oh-my-opencode/src/features/background-agent/manager.ts:1263-1267`

There is no evidence in this path of a "wait until the old session is definitively terminated, then forget it" protocol.

## Where The Previous Report Was Too Strong

The earlier report made a plausible leap that should now be stated more carefully:

- It strongly implied the later bandwidth burst was caused by old sessions sending large accumulated context after usage became available again.

What the current code review supports is narrower:

- orphaned or long-lived subagent sessions are possible
- those sessions can continue hosted inference work after the user believes the pane is idle
- that is sufficient to explain large outbound traffic

What is still not directly proven from local evidence alone:

- the exact plaintext payloads sent over HTTPS
- whether every leaked session resent its full prior context
- whether the bandwidth event came from only orphaned superseded sessions, or from a mix of orphaned sessions plus legitimately still-running fallback sessions

So the corrected statement should be:

> The bandwidth spike is highly consistent with active hosted inference from background subagent sessions that remained alive longer than intended. The code review confirms a fallback orphaning bug that can leave superseded sessions running untracked.

## Evidence That Matches The Code Review

The earlier investigation documented that the first fallback from Claude to OpenCode-hosted models did happen. The logs we reviewed show:

- fallback to `opencode/minimax-m2.5-free`
- then long periods of `sessionStatus:"retry"` with `toolCalls:0`

Representative log lines:

- `/tmp/oh-my-opencode.log:51629-51630`
- `/tmp/oh-my-opencode.log:53549-53557`

That sequence matches the code bug:

1. original session hits rate limit
2. fallback is launched
3. original session ownership is dropped immediately
4. replacement session may itself stall in `retry`
5. stale watchdog does not reap it because `retry` counts as running

## Why This Matters For Bandwidth

If a superseded subagent session is still alive after fallback:

- it can continue talking to a hosted provider
- it can keep consuming context and tokens outside the user's awareness
- its activity may not show up in the pane in a way the user expects
- it may coexist with the fallback session, multiplying outbound traffic

That is exactly the kind of failure mode that could turn "I left one OpenCode pane open" into "hours later, the process is still pushing data to hosted inference endpoints".

## Updated Conclusion

The previous report remains valid on the high-level diagnosis: this was active OpenCode inference work, not ordinary telemetry.

The code review now identifies a specific implementation defect that can explain the persistence:

- subagent failover does not guarantee that the superseded session is actually ended before the fallback session takes over
- the manager forgets the superseded session too early
- retry-state sessions are not aggressively reaped

That combination is sufficient to create orphaned background inference sessions and sustained bandwidth use long after the user believes the pane is idle.

## Recommended Interpretation Going Forward

The best current explanation is:

1. an old background subagent hit a provider/rate-limit problem
2. fallback was attempted
3. the old session was aborted but not confirmed dead
4. local ownership of that old session was dropped immediately
5. one or more sessions in that work tree continued running or retrying against hosted providers
6. this produced the observed outbound traffic

This is a subagent lifecycle / fallback-cleanup bug first, and a bandwidth symptom second.
