import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createSessionStatusHandler } from "./session-status-handler"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

function createContext(): RuntimeFallbackPluginInput {
  return {
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
  }
}

function createDeps(): HookDeps {
  return {
    ctx: createContext(),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 4,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {
      categories: {
        test: {
          fallback_models: ["openai/gpt-5.4", "google/gemini-2.5-pro"],
        },
      },
    },
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
    sessionTokenRefreshRetryCounts: new Map(),
  }
}

function createHelpers(
  clearCalls: string[],
  retryCalls: Array<{ sessionID: string; model: string; source: string }>,
): AutoRetryHelpers {
  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls.push(sessionID)
    },
    scheduleSessionFallbackTimeout: () => {},
    autoRetryWithFallback: async (sessionID: string, model: string, _resolvedAgent: string | undefined, source: string) => {
      retryCalls.push({ sessionID, model, source })
    },
    retryCurrentModelAfterTokenRefreshFailure: async () => "allow-fallback",
    clearTokenRefreshRetryState: () => {},
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
}

beforeEach(() => {
  SessionCategoryRegistry.clear()
})

afterEach(() => {
  SessionCategoryRegistry.clear()
})

describe("createSessionStatusHandler", () => {
  it("#given a pending fallback model #when a provider cooldown retry arrives #then the handler triggers immediate fallback", async () => {
    // given
    const sessionID = "session-status-pending-fallback"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.failedModels.set("anthropic/claude-opus-4-6", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(clearCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model gpt-5.4 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    // then
    expect(clearCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      { sessionID, model: "google/gemini-2.5-pro", source: "session.status" },
    ])
    expect(state.currentModel).toBe("google/gemini-2.5-pro")
    expect(deps.sessionStatusRetryKeys.get(sessionID)).toBe(
      "2:all credentials for model gpt-5.4 are cooling down [retrying]"
    )
  })

  it("#given no existing state #when a provider retry arrives with model info #then a fallback state is bootstrapped and fallback dispatched", async () => {
    // given
    const sessionID = "session-status-bootstrap"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const handler = createSessionStatusHandler(deps, createHelpers(clearCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-6",
      status: {
        type: "retry",
        attempt: 1,
        message: "The usage limit has been reached [retrying in 27s attempt #1]",
      },
    })

    // then
    expect(clearCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      { sessionID, model: "openai/gpt-5.4", source: "session.status" },
    ])
    const state = deps.sessionStates.get(sessionID)
    expect(state).toBeDefined()
    expect(state!.originalModel).toBe("anthropic/claude-opus-4-6")
    expect(state!.currentModel).toBe("openai/gpt-5.4")
  })

  it("#given a duplicate retry key #when the same retry arrives again #then the handler deduplicates and skips", async () => {
    // given
    const sessionID = "session-status-dedup"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))

    const handler = createSessionStatusHandler(deps, createHelpers(clearCalls, retryCalls), deps.sessionStatusRetryKeys)

    const statusProps = {
      sessionID,
      model: "anthropic/claude-opus-4-6",
      status: {
        type: "retry",
        attempt: 1,
        message: "Too Many Requests [retrying in 2s attempt #1]",
      },
    }

    // when
    await handler(statusProps)
    await handler(statusProps)

    // then
    expect(retryCalls.length).toBe(1)
  })

  it("#given a non-retry status type #when a status event arrives #then the handler ignores it", async () => {
    // given
    const sessionID = "session-status-non-retry"
    const deps = createDeps()
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const handler = createSessionStatusHandler(deps, createHelpers(clearCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-6",
      status: { type: "running", message: "Processing..." },
    })

    // then
    expect(clearCalls).toEqual([])
    expect(retryCalls).toEqual([])
  })
})
