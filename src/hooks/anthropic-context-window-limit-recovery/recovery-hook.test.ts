import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import * as recoveryExecutor from "./executor"
import * as recoveryParser from "./parser"
import * as sharedLogger from "../../shared/logger"
import { createAnthropicContextWindowLimitRecoveryHook } from "./recovery-hook"

function createMockContext(): PluginInput {
  return {
    client: {
      session: {
        messages: mock(() => Promise.resolve({ data: [] })),
      },
      tui: {
        showToast: mock(() => Promise.resolve()),
      },
    },
    directory: "/tmp",
  } as PluginInput
}

function setupDelayedTimeoutMocks(): {
  restore: () => void
  getClearTimeoutCalls: () => Array<ReturnType<typeof setTimeout>>
} {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const clearTimeoutCalls: Array<ReturnType<typeof setTimeout>> = []
  let timeoutCounter = 0

  globalThis.setTimeout = ((_: () => void, _delay?: number) => {
    timeoutCounter += 1
    return timeoutCounter as ReturnType<typeof setTimeout>
  }) as typeof setTimeout

  globalThis.clearTimeout = ((timeoutID: ReturnType<typeof setTimeout>) => {
    clearTimeoutCalls.push(timeoutID)
  }) as typeof clearTimeout

  return {
    restore: () => {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
    getClearTimeoutCalls: () => clearTimeoutCalls,
  }
}

describe("createAnthropicContextWindowLimitRecoveryHook", () => {
  let executeCompactSpy: ReturnType<typeof spyOn>
  let getLastAssistantSpy: ReturnType<typeof spyOn>
  let parseAnthropicTokenLimitErrorSpy: ReturnType<typeof spyOn>
  let loggerSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    executeCompactSpy = spyOn(recoveryExecutor, "executeCompact").mockResolvedValue(undefined)
    getLastAssistantSpy = spyOn(recoveryExecutor, "getLastAssistant").mockResolvedValue({
      info: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
      },
      hasContent: true,
    })
    parseAnthropicTokenLimitErrorSpy = spyOn(
      recoveryParser,
      "parseAnthropicTokenLimitError",
    ).mockReturnValue({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    })
    loggerSpy = spyOn(sharedLogger, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    executeCompactSpy?.mockRestore()
    getLastAssistantSpy?.mockRestore()
    parseAnthropicTokenLimitErrorSpy?.mockRestore()
    loggerSpy?.mockRestore()
  })

  test("cancels pending timer when session.idle handles compaction first", async () => {
    //#given
    const { restore, getClearTimeoutCalls } = setupDelayedTimeoutMocks()
    const hook = createAnthropicContextWindowLimitRecoveryHook(createMockContext())

    try {
      //#when
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "session-race", error: "prompt is too long" },
        },
      })

      await hook.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-race" },
        },
      })

      //#then
      expect(getClearTimeoutCalls()).toEqual([1 as ReturnType<typeof setTimeout>])
      expect(executeCompactSpy).toHaveBeenCalledTimes(1)
      expect(executeCompactSpy.mock.calls[0]?.[0]).toBe("session-race")
    } finally {
      restore()
    }
  })

  test("does not treat empty summary assistant messages as successful compaction", async () => {
    //#given
    const { restore, getClearTimeoutCalls } = setupDelayedTimeoutMocks()
    getLastAssistantSpy.mockResolvedValueOnce({
      info: {
        summary: true,
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
      },
      hasContent: false,
    })
    const hook = createAnthropicContextWindowLimitRecoveryHook(createMockContext())

    try {
      //#when
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "session-empty-summary", error: "prompt is too long" },
        },
      })

      await hook.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-empty-summary" },
        },
      })

      //#then
      expect(getClearTimeoutCalls()).toEqual([1 as ReturnType<typeof setTimeout>])
      expect(executeCompactSpy).toHaveBeenCalledTimes(1)
      expect(executeCompactSpy.mock.calls[0]?.[0]).toBe("session-empty-summary")
    } finally {
      restore()
    }
  })
})
