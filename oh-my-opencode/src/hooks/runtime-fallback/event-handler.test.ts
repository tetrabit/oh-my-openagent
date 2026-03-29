import { describe, expect, it } from "bun:test"
import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createEventHandler } from "./event-handler"

function createDeps(): HookDeps {
  return {
    ctx: {
      client: {
        session: {
          abort: async () => ({}),
          messages: async () => ({ data: [] }),
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
  abortCalls: string[],
  clearCalls: string[],
  retryCalls: Array<{ sessionID: string; model: string; source: string }>,
): AutoRetryHelpers {
  return {
    abortSessionRequest: async (sessionID: string) => {
      abortCalls.push(sessionID)
    },
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls.push(sessionID)
      deps.sessionFallbackTimeouts.delete(sessionID)
    },
    scheduleSessionFallbackTimeout: () => {},
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

describe("createEventHandler", () => {
  it("keeps the current model active for provider-managed session.status retries", async () => {
    const sessionID = "session-status-provider-retry"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.currentModel = "openai/gpt-5.4"
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, setTimeout(() => {}, 1))
    const handler = createEventHandler(deps, createHelpers(deps, abortCalls, clearCalls, retryCalls))

    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 1,
            message: "All credentials for model gpt-5.4 are cooling down [retrying in 7m 56s attempt #1]",
          },
        },
      },
    })

    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(clearCalls).toEqual([sessionID])
    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
  })

  it("retries the same anthropic model before provider fallback on token refresh failures", async () => {
    const sessionID = "session-token-refresh"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    const handler = createEventHandler(deps, createHelpers(deps, abortCalls, clearCalls, retryCalls))

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: {
            name: "UnknownError",
            data: {
              message: "Error: Token refresh failed: 400",
            },
          },
        },
      },
    })

    expect(abortCalls).toEqual([])
    expect(clearCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "anthropic/claude-opus-4-6",
        source: "session.error",
      },
    ])
  })
})
