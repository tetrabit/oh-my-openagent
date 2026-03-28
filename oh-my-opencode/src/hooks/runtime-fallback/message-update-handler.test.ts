import { describe, expect, it } from "bun:test"
import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createMessageUpdateHandler } from "./message-update-handler"

function createDeps(messagesResponse: unknown): HookDeps {
  return {
    ctx: {
      client: {
        session: {
          abort: async () => ({}),
          messages: async () => messagesResponse,
          promptAsync: async () => ({}),
        },
        tui: {
          showToast: async () => ({}),
        },
      },
      directory: "/test/dir",
    },
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {},
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTokenRefreshRetryCounts: new Map(),
  }
}

function createHelpers(
  deps: HookDeps,
  clearCalls: string[],
  scheduleCalls: string[],
  retryCalls: Array<{ sessionID: string; model: string; source: string }>,
): AutoRetryHelpers {
  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls.push(sessionID)
      deps.sessionFallbackTimeouts.delete(sessionID)
    },
    scheduleSessionFallbackTimeout: (sessionID: string) => {
      scheduleCalls.push(sessionID)
    },
    autoRetryWithFallback: async (sessionID: string, model: string, _resolvedAgent: string | undefined, source: string) => {
      retryCalls.push({ sessionID, model, source })
    },
    retryCurrentModelAfterTokenRefreshFailure: async (sessionID: string, model: string, _resolvedAgent: string | undefined, source: string) => {
      retryCalls.push({ sessionID, model, source })
      return "retry-dispatched"
    },
    clearTokenRefreshRetryState: (sessionID: string) => {
      deps.sessionTokenRefreshRetryCounts.delete(sessionID)
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
}

describe("createMessageUpdateHandler", () => {
  it("clears the timeout after fallback assistant activity begins", async () => {
    const sessionID = "assistant-progress"
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "run the task" }] },
        { info: { role: "assistant" }, parts: [{ type: "tool", text: "bash" }] },
      ],
    })
    const clearCalls: string[] = []
    const scheduleCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.currentModel = "openai/gpt-5.4"
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, setTimeout(() => {}, 1))
    deps.sessionTokenRefreshRetryCounts.set(sessionID, 2)
    const handler = createMessageUpdateHandler(deps, createHelpers(deps, clearCalls, scheduleCalls, retryCalls))

    await handler({
      info: {
        sessionID,
        role: "assistant",
        model: "openai/gpt-5.4",
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(scheduleCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionTokenRefreshRetryCounts.has(sessionID)).toBe(false)
    expect(state.pendingFallbackModel).toBe(undefined)
  })

  it("retries the same anthropic model before provider fallback on token refresh assistant errors", async () => {
    const sessionID = "assistant-token-refresh"
    const deps = createDeps({
      data: [{ info: { role: "user" }, parts: [{ type: "text", text: "run the task" }] }],
    })
    const clearCalls: string[] = []
    const scheduleCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    const handler = createMessageUpdateHandler(deps, createHelpers(deps, clearCalls, scheduleCalls, retryCalls))

    await handler({
      info: {
        sessionID,
        role: "assistant",
        model: "anthropic/claude-opus-4-6",
        error: {
          name: "UnknownError",
          data: {
            message: "Error: Token refresh failed: 400",
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(scheduleCalls).toEqual([])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "anthropic/claude-opus-4-6",
        source: "message.updated",
      },
    ])
  })
})
