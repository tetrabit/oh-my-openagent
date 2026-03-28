import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createMessageUpdateHandler } from "./message-update-handler"
import { hasVisibleAssistantResponse } from "./visible-assistant-response"
import { extractAutoRetrySignal } from "./error-classifier"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

function createContext(messagesResponse: unknown): RuntimeFallbackPluginInput {
  return {
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
  }
}

beforeEach(() => {
  SessionCategoryRegistry.clear()
})

afterEach(() => {
  SessionCategoryRegistry.clear()
})

describe("hasVisibleAssistantResponse", () => {
  it("#given only an old assistant reply before the latest user turn #when visibility is checked #then the stale reply is ignored", async () => {
    // given
    const checkVisibleResponse = hasVisibleAssistantResponse(() => undefined)
    const ctx = createContext({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "older question" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "older answer" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "latest question" }] },
      ],
    })

    // when
    const result = await checkVisibleResponse(ctx, "session-old-assistant", undefined)

    // then
    expect(result).toBe(false)
  })

  it("#given an assistant reply after the latest user turn #when visibility is checked #then the current reply is treated as visible", async () => {
    // given
    const checkVisibleResponse = hasVisibleAssistantResponse(() => undefined)
    const ctx = createContext({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "latest question" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "visible answer" }] },
      ],
    })

    // when
    const result = await checkVisibleResponse(ctx, "session-visible-assistant", undefined)

    // then
    expect(result).toBe(true)
  })

  it("#given a too-many-requests assistant reply #when visibility is checked #then it is treated as an auto-retry signal", async () => {
    // given
    const checkVisibleResponse = hasVisibleAssistantResponse(extractAutoRetrySignal)
    const ctx = createContext({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "latest question" }] },
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "text",
              text: "Too Many Requests: Sorry, you've exhausted this model's rate limit. Please try a different model.",
            },
          ],
        },
      ],
    })

    // when
    const result = await checkVisibleResponse(ctx, "session-rate-limit", undefined)

    // then
    expect(result).toBe(false)
  })
})

function createDeps(messagesResponse: unknown): HookDeps {
  return {
    ctx: createContext(messagesResponse),
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
  clearCalls: string[],
  retryCalls: Array<{ sessionID: string; model: string; source: string }>,
): AutoRetryHelpers {
  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls.push(sessionID)
      deps.sessionFallbackTimeouts.delete(sessionID)
    },
    scheduleSessionFallbackTimeout: () => {},
    autoRetryWithFallback: async (
      sessionID: string,
      model: string,
      _resolvedAgent: string | undefined,
      source: string,
    ) => {
      retryCalls.push({ sessionID, model, source })
    },
    retryCurrentModelAfterTokenRefreshFailure: async (
      sessionID: string,
      model: string,
      _resolvedAgent: string | undefined,
      source: string,
    ) => {
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
  it("#given fallback assistant tool activity #when an assistant update arrives #then the timeout is cleared without advancing the chain", async () => {
    // given
    const sessionID = "assistant-progress"
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "run the task" }] },
        { info: { role: "assistant" }, parts: [{ type: "tool", text: "bash" }] },
      ],
    })
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.currentModel = "openai/gpt-5.4"
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, 1)
    deps.sessionTokenRefreshRetryCounts.set(sessionID, 2)
    const handler = createMessageUpdateHandler(deps, createHelpers(deps, clearCalls, retryCalls))

    // when
    await handler({
      info: {
        sessionID,
        role: "assistant",
        model: "openai/gpt-5.4",
      },
    })

    // then
    expect(clearCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([])
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionTokenRefreshRetryCounts.has(sessionID)).toBe(false)
    expect(state.pendingFallbackModel).toBe(undefined)
  })

  it("#given a provider-managed retry notice while awaiting fallback #when an assistant update arrives #then the timeout is suspended without another fallback", async () => {
    // given
    const sessionID = "assistant-provider-retry"
    const deps = createDeps({
      data: [{ info: { role: "user" }, parts: [{ type: "text", text: "run the task" }] }],
    })
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.currentModel = "openai/gpt-5.4"
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, 1)
    const handler = createMessageUpdateHandler(deps, createHelpers(deps, clearCalls, retryCalls))

    // when
    await handler({
      info: {
        sessionID,
        role: "assistant",
        model: "openai/gpt-5.4",
        status: "The usage limit has been reached [retrying in 27s attempt #6]",
      },
    })

    // then
    expect(clearCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([])
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
  })

  it("#given an anthropic token refresh failure in assistant output #when message.updated arrives #then the handler retries the current model before fallback", async () => {
    // given
    const sessionID = "assistant-token-refresh"
    const deps = createDeps({
      data: [{ info: { role: "user" }, parts: [{ type: "text", text: "run the task" }] }],
    })
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    const handler = createMessageUpdateHandler(deps, createHelpers(deps, clearCalls, retryCalls))

    // when
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

    // then
    expect(clearCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "anthropic/claude-opus-4-6",
        source: "message.updated",
      },
    ])
  })

  it("#given mixed assistant text and type:error parts #when message.updated arrives #then fallback is dispatched from explicit error content", async () => {
    // given
    const sessionID = "assistant-mixed-error-content"
    const deps = createDeps({
      data: [{ info: { role: "user" }, parts: [{ type: "text", text: "run the task" }] }],
    })
    deps.pluginConfig = {
      categories: {
        test: {
          fallback_models: ["openai/gpt-5.4"],
        },
      },
    }
    SessionCategoryRegistry.register(sessionID, "test")
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    const clearCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const handler = createMessageUpdateHandler(deps, createHelpers(deps, clearCalls, retryCalls))

    // when
    await handler({
      info: {
        sessionID,
        role: "assistant",
        model: "anthropic/claude-opus-4-6",
      },
      parts: [
        {
          type: "text",
          text: "Too Many Requests: Sorry, you've exhausted this model's rate limit. Please try a different model.",
        },
        {
          type: "error",
          text: "Rate limit exceeded",
        },
      ],
    })

    // then
    expect(clearCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "message.updated",
      },
    ])
  })
})
