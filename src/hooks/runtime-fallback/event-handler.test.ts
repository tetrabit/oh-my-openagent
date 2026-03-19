import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"

let moduleImportCounter = 0
let createEventHandler: typeof import("./event-handler").createEventHandler

async function prepareEventHandlerTestModule(): Promise<void> {
  mock.restore()
  moduleImportCounter += 1
  ;({ createEventHandler } = await import(`./event-handler?test=${moduleImportCounter}`))
}

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
    sessionStatusRetryKeys: new Map(),
    sessionTokenRefreshRetryCounts: new Map(),
  }
}

function createHelpers(
  deps: HookDeps,
  abortCalls: string[],
  clearCalls: string[],
  tokenRefreshRetryCalls: Array<{ sessionID: string; model: string; source: string }>,
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
    autoRetryWithFallback: async () => {},
    retryCurrentModelAfterTokenRefreshFailure: async (
      sessionID: string,
      model: string,
      _resolvedAgent: string | undefined,
      source: string,
    ) => {
      tokenRefreshRetryCalls.push({ sessionID, model, source })
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
  beforeEach(async () => {
    await prepareEventHandlerTestModule()
  })

  afterEach(() => {
    mock.restore()
  })

  it("#given a session retry dedupe key #when session.stop fires #then the retry dedupe key is cleared", async () => {
    // given
    const sessionID = "session-stop"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const tokenRefreshRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("google/gemini-2.5-pro")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const handler = createEventHandler(deps, createHelpers(deps, abortCalls, clearCalls, tokenRefreshRetryCalls))

    // when
    await handler({ event: { type: "session.stop", properties: { sessionID } } })

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([sessionID])
  })

  it("#given a session retry dedupe key without a pending fallback result #when session.idle fires #then the retry dedupe key is cleared", async () => {
    // given
    const sessionID = "session-idle"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const tokenRefreshRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("google/gemini-2.5-pro")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, 1)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const handler = createEventHandler(deps, createHelpers(deps, abortCalls, clearCalls, tokenRefreshRetryCalls))

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(state.pendingFallbackModel).toBe(undefined)
  })

  it("#given a fallback result without an armed timeout #when session.idle fires #then retry state is cleaned up", async () => {
    // given
    const sessionID = "session-idle-no-timeout"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const tokenRefreshRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("google/gemini-2.5-pro")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    const handler = createEventHandler(deps, createHelpers(deps, abortCalls, clearCalls, tokenRefreshRetryCalls))

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(state.pendingFallbackModel).toBe(undefined)
  })

  it("#given an anthropic token refresh failure #when session.error fires #then the handler retries the same model before fallback", async () => {
    // given
    const sessionID = "session-token-refresh"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const tokenRefreshRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    const handler = createEventHandler(deps, createHelpers(deps, abortCalls, clearCalls, tokenRefreshRetryCalls))

    // when
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

    // then
    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(tokenRefreshRetryCalls).toEqual([
      {
        sessionID,
        model: "anthropic/claude-opus-4-6",
        source: "session.error",
      },
    ])
  })
})
