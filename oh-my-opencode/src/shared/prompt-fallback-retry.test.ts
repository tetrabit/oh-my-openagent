import { describe, expect, mock, test } from "bun:test"
import { sendPromptWithFallbackRetry } from "./prompt-fallback-retry"

describe("sendPromptWithFallbackRetry", () => {
  test("skips a duplicate fallback candidate that matches the current model", async () => {
    // given
    const promptCalls: Array<Record<string, unknown>> = []
    const sendPrompt = mock(async (args: Record<string, unknown>) => {
      promptCalls.push(args)
      if (promptCalls.length === 1) {
        const error = new Error("quota exceeded")
        error.name = "MessageAbortedError"
        throw error
      }
    })

    // when
    const result = await sendPromptWithFallbackRetry({
      promptArgs: {
        path: { id: "ses-test" },
        body: {
          agent: "oracle",
          model: {
            providerID: "openai",
            modelID: "gpt-5.2",
          },
        },
      },
      currentModel: {
        providerID: "openai",
        modelID: "gpt-5.2",
      },
      fallbackChain: [
        { providers: ["openai"], model: "gpt-5.2" },
        { providers: ["google"], model: "gemini-3-flash-preview" },
      ],
      sendPrompt,
    })

    // then
    expect(result).toEqual({
      providerID: "google",
      modelID: "gemini-3-flash-preview",
      variant: undefined,
      usedFallback: true,
    })
    expect(promptCalls).toHaveLength(2)
    expect((promptCalls[1].body as Record<string, unknown>).model).toEqual({
      providerID: "google",
      modelID: "gemini-3-flash-preview",
    })
  })

  test("rethrows non-retryable startup errors without consuming the fallback chain", async () => {
    // given
    const sendPrompt = mock(async () => {
      const error = new Error("permission denied")
      error.name = "PermissionDeniedError"
      throw error
    })

    // when / then
    await expect(
      sendPromptWithFallbackRetry({
        promptArgs: {
          path: { id: "ses-test" },
          body: {
            agent: "oracle",
          },
        },
        fallbackChain: [
          { providers: ["google"], model: "gemini-3-flash-preview" },
        ],
        sendPrompt,
      }),
    ).rejects.toThrow("permission denied")
  })
})
