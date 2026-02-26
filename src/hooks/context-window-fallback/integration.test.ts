import { beforeEach, describe, expect, mock, test } from "bun:test";

const promptAsyncMock = mock(async (_input: unknown) => undefined);
const showToastMock = mock(async () => undefined);

mock.module("../../features/claude-code-session-state", () => ({
  getSessionAgent: () => "sisyphus",
}));

mock.module("../../shared/model-availability", () => ({
  fetchAvailableModels: async () =>
    new Set<string>(["anthropic/claude-opus-4-6", "openai/gpt-5.2"]),
}));

mock.module("../../shared/model-resolver", () => ({
  resolveRuntimeFallback: () => ({
    model: "openai/gpt-5.2",
    source: "runtime-fallback",
  }),
}));

describe("context-window-fallback integration", () => {
  beforeEach(() => {
    promptAsyncMock.mockClear();
    showToastMock.mockClear();
  });

  test("switches model and calls promptAsync on session.error rate-limit event", async () => {
    // #given
    const { createContextWindowFallbackHook } = await import("./index");

    const ctx = {
      directory: "/tmp/project",
      client: {
        session: {
          messages: mock(async () => ({ data: [] })),
          promptAsync: promptAsyncMock,
        },
        tui: {
          showToast: showToastMock,
        },
      },
    } as unknown as Parameters<typeof createContextWindowFallbackHook>[0];

    const hook = createContextWindowFallbackHook(ctx);

    const eventInput = {
      event: {
        type: "session.error",
        properties: {
          sessionID: "session-rate-limit-1",
          error: {
            name: "APIError",
            data: {
              message:
                "This request would exceed your account's rate limit. Please try again later.",
              statusCode: 429,
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
        },
      },
    };

    // #when
    const handled = await hook.event(eventInput);

    // #then
    expect(handled).toBe(true);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);

    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "session-rate-limit-1" },
      body: {
        auto: true,
        model: {
          providerID: "openai",
          modelID: "gpt-5.2",
        },
      },
      query: { directory: "/tmp/project" },
    });
  });

  test("switches model and calls promptAsync on session.error context-overflow event", async () => {
    // #given
    const { createContextWindowFallbackHook } = await import("./index");

    const ctx = {
      directory: "/tmp/project",
      client: {
        session: {
          messages: mock(async () => ({ data: [] })),
          promptAsync: promptAsyncMock,
        },
        tui: {
          showToast: showToastMock,
        },
      },
    } as unknown as Parameters<typeof createContextWindowFallbackHook>[0];

    const hook = createContextWindowFallbackHook(ctx);

    const eventInput = {
      event: {
        type: "session.error",
        properties: {
          sessionID: "session-context-overflow-1",
          error: {
            name: "ContextOverflowError",
            data: {
              message: "This message would exceed the model context window",
              currentTokens: 245000,
              maxTokens: 200000,
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
        },
      },
    };

    // #when
    const handled = await hook.event(eventInput);

    // #then
    expect(handled).toBe(true);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);

    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "session-context-overflow-1" },
      body: {
        auto: true,
        model: {
          providerID: "openai",
          modelID: "gpt-5.2",
        },
      },
      query: { directory: "/tmp/project" },
    });
  });
});
