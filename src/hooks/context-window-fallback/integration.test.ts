import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as modelAvailability from "../../shared/model-availability";
import * as modelResolver from "../../shared/model-resolver";
import * as sessionState from "../../features/claude-code-session-state";
import { createContextWindowFallbackHook } from "./index";

const promptAsyncMock = mock(async (_input: unknown) => undefined);
const showToastMock = mock(async () => undefined);

describe("context-window-fallback integration", () => {
  beforeEach(() => {
    mock.restore();
    spyOn(modelAvailability, "fetchAvailableModels").mockResolvedValue(
      new Set<string>(["anthropic/claude-opus-4-6", "openai/gpt-5.2"]),
    );
    spyOn(modelResolver, "resolveRuntimeFallback").mockReturnValue({
      model: "openai/gpt-5.2",
      source: "runtime-fallback",
    });

    promptAsyncMock.mockClear();
    showToastMock.mockClear();
    sessionState._resetForTesting();
  });

  afterEach(() => {
    sessionState._resetForTesting();
    mock.restore();
  });

  test("switches model and calls promptAsync on session.error rate-limit event", async () => {
    // #given
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
    sessionState.updateSessionAgent("session-rate-limit-1", "sisyphus");

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
    sessionState.updateSessionAgent("session-context-overflow-1", "sisyphus");

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

  test("switches model for subagent sessions on session.error context-overflow event", async () => {
    // #given
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
    const subagentSessionID = "subagent-context-overflow-1";
    sessionState.subagentSessions.add(subagentSessionID);
    sessionState.updateSessionAgent(subagentSessionID, "hephaestus");

    const eventInput = {
      event: {
        type: "session.error",
        properties: {
          sessionID: subagentSessionID,
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
      path: { id: subagentSessionID },
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
