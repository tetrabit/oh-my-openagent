import { describe, expect, mock, test } from "bun:test"
import { sendPromptWithFallbackRetry } from "./prompt-fallback-retry"
import { OPENCODE_PROMPT_QUEUE_METADATA_KEY } from "./prompt-queue-control"

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
          parts: [{ type: "text", text: "start prompt" }],
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
    const firstPart = ((promptCalls[1].body as Record<string, unknown>).parts as Array<Record<string, unknown>>)[0]
    expect(firstPart?.metadata).toBeDefined()
    const queueControl = (firstPart?.metadata as Record<string, unknown>)[OPENCODE_PROMPT_QUEUE_METADATA_KEY] as
      | Record<string, unknown>
      | undefined
    expect(queueControl?.supersedePending).toBe("all")
    expect(typeof queueControl?.supersessionKey).toBe("string")
    expect(typeof queueControl?.attemptID).toBe("string")
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

  test("tags the initial attempt so fallback can tombstone it later", async () => {
    // given
    const promptCalls: Array<Record<string, unknown>> = []
    const sendPrompt = mock(async (args: Record<string, unknown>) => {
      promptCalls.push(args)
    })

    // when
    await sendPromptWithFallbackRetry({
      promptArgs: {
        path: { id: "ses-test" },
        body: {
          agent: "oracle",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      sendPrompt,
    })

    // then
    expect(promptCalls).toHaveLength(1)
    const firstPart = ((promptCalls[0].body as Record<string, unknown>).parts as Array<Record<string, unknown>>)[0]
    const queueControl = (firstPart?.metadata as Record<string, unknown>)[OPENCODE_PROMPT_QUEUE_METADATA_KEY] as
      | Record<string, unknown>
      | undefined
    expect(queueControl?.supersedePending).toBeUndefined()
    expect(typeof queueControl?.supersessionKey).toBe("string")
    expect(typeof queueControl?.attemptID).toBe("string")
  })
})
