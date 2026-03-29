import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { RuntimeFallbackPluginInput } from "./types"
import { createRuntimeFallbackHook } from "./hook"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

function createMockContext(promptCalls: unknown[]): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({
          data: [{ info: { role: "user" }, parts: [{ type: "text", text: "retry this" }] }],
        }),
        promptAsync: async (args: unknown) => {
          promptCalls.push(args)
          return {}
        },
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

describe("createRuntimeFallbackHook dispose", () => {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const createdIntervals: Array<ReturnType<typeof originalSetInterval>> = []
  const clearedIntervals: Array<Parameters<typeof originalClearInterval>[0]> = []
  const createdTimeouts: Array<ReturnType<typeof originalSetTimeout>> = []
  const clearedTimeouts: Array<Parameters<typeof originalClearTimeout>[0]> = []

  beforeEach(() => {
    SessionCategoryRegistry.clear()
    createdIntervals.length = 0
    clearedIntervals.length = 0
    createdTimeouts.length = 0
    clearedTimeouts.length = 0

    globalThis.setInterval = ((handler: () => void, timeout?: number) => {
      const interval = originalSetInterval(handler, timeout)
      createdIntervals.push(interval)
      return interval
    }) as typeof globalThis.setInterval

    globalThis.clearInterval = ((interval?: Parameters<typeof clearInterval>[0]) => {
      clearedIntervals.push(interval)
      return originalClearInterval(interval)
    }) as typeof globalThis.clearInterval

    globalThis.setTimeout = ((handler: () => void | Promise<void>, timeout?: number) => {
      const timer = originalSetTimeout(handler, timeout)
      createdTimeouts.push(timer)
      return timer
    }) as typeof globalThis.setTimeout

    globalThis.clearTimeout = ((timeout?: Parameters<typeof clearTimeout>[0]) => {
      clearedTimeouts.push(timeout)
      return originalClearTimeout(timeout)
    }) as typeof globalThis.clearTimeout
  })

  afterEach(() => {
    SessionCategoryRegistry.clear()
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })

  test("#given runtime-fallback hook created #when dispose() is called #then cleanup interval is cleared", () => {
    // given
    const hook = createRuntimeFallbackHook(createMockContext([]), { pluginConfig: {} })

    // when
    hook.dispose?.()

    // then
    expect(createdIntervals).toHaveLength(1)
    expect(clearedIntervals).toEqual([createdIntervals[0]])
  })

  test("#given pending fallback timeout #when dispose() is called #then the timeout is cleared", async () => {
    // given
    const promptCalls: unknown[] = []
    const sessionID = "session-dispose-timeout"
    const hook = createRuntimeFallbackHook(createMockContext(promptCalls), {
      config: {
        enabled: true,
        retry_on_errors: [429, 503, 529],
        max_fallback_attempts: 3,
        cooldown_seconds: 60,
        timeout_seconds: 30,
        notify_on_fallback: false,
      },
      pluginConfig: {
        categories: {
          test: {
            fallback_models: ["openai/gpt-5.2"],
          },
        },
      },
    })
    SessionCategoryRegistry.register(sessionID, "test")

    await hook.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionID, model: "quotio/claude-opus-4-6" } },
      },
    })

    await hook.event({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: {
            statusCode: 429,
            message: "Rate limit exceeded",
          },
        },
      },
    })

    // when
    hook.dispose?.()

    // then
    expect(promptCalls).toHaveLength(1)
    expect(createdTimeouts.length).toBeGreaterThan(0)
    expect(clearedTimeouts).toContain(createdTimeouts[0])
  })
})
