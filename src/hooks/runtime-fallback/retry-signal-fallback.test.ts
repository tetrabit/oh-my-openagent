import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { dispatchFallbackOnRetrySignal } from "./retry-signal-fallback"
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
  retryCalls: Array<{ sessionID: string; model: string; source: string }>,
): AutoRetryHelpers {
  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: () => {},
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

describe("dispatchFallbackOnRetrySignal", () => {
  it("#given a session with fallback models configured #when called #then it dispatches fallback and returns true", async () => {
    // given
    const sessionID = "retry-signal-test"
    SessionCategoryRegistry.register(sessionID, "test")
    const deps = createDeps()
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []

    // when
    const result = await dispatchFallbackOnRetrySignal(deps, createHelpers(retryCalls), {
      sessionID,
      model: "anthropic/claude-opus-4-6",
      agent: undefined,
      source: "test",
    })

    // then
    expect(result).toBe(true)
    expect(retryCalls).toEqual([
      { sessionID, model: "openai/gpt-5.4", source: "test" },
    ])
  })

  it("#given no fallback models configured #when called #then it returns false without dispatching", async () => {
    // given
    const sessionID = "retry-signal-no-models"
    const deps = createDeps()
    deps.pluginConfig = {}
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []

    // when
    const result = await dispatchFallbackOnRetrySignal(deps, createHelpers(retryCalls), {
      sessionID,
      model: "anthropic/claude-opus-4-6",
      agent: undefined,
      source: "test",
    })

    // then
    expect(result).toBe(false)
    expect(retryCalls).toEqual([])
  })

  it("#given no existing state but model info provided #when called #then it bootstraps state and dispatches fallback", async () => {
    // given
    const sessionID = "retry-signal-bootstrap"
    SessionCategoryRegistry.register(sessionID, "test")
    const deps = createDeps()
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []

    // when
    const result = await dispatchFallbackOnRetrySignal(deps, createHelpers(retryCalls), {
      sessionID,
      model: "anthropic/claude-opus-4-6",
      agent: undefined,
      source: "test",
    })

    // then
    expect(result).toBe(true)
    expect(deps.sessionStates.has(sessionID)).toBe(true)
    expect(retryCalls.length).toBe(1)
  })
})