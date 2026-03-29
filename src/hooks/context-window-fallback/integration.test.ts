import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const promptAsyncMock = mock(async (_input: unknown) => undefined);
const showToastMock = mock(async () => undefined);
let moduleImportCounter = 0;
let createContextWindowFallbackHook: typeof import("./index").createContextWindowFallbackHook;
let sessionState: typeof import("../../features/claude-code-session-state");

async function restoreActualContextWindowFallbackDependencies(): Promise<void> {
  moduleImportCounter += 1;
  const modelAvailabilityModule = await import(
    `../../shared/model-availability?restore=${moduleImportCounter}`
  );
  const modelResolverModule = await import(
    `../../shared/model-resolver?restore=${moduleImportCounter}`
  );

  mock.restore();
  mock.module("../../shared/model-availability", () => modelAvailabilityModule);
  mock.module("../../shared/model-resolver", () => modelResolverModule);
}

async function prepareContextWindowFallbackModule(): Promise<void> {
  mock.restore();
  sessionState = await import(`../../features/claude-code-session-state/index?test=${moduleImportCounter + 1}`);

  const realModelAvailability = await import(`../../shared/model-availability?test=${moduleImportCounter + 1}`);
  mock.module("../../shared/model-availability", () => ({
    ...realModelAvailability,
    fetchAvailableModels: async () =>
      new Set<string>(["anthropic/claude-opus-4-6", "openai/gpt-5.2"]),
    fuzzyMatchModel: () => "openai/gpt-5.2",
  }));

  const realModelResolver = await import(`../../shared/model-resolver?test=${moduleImportCounter + 1}`);
  mock.module("../../shared/model-resolver", () => ({
    ...realModelResolver,
    resolveRuntimeFallback: () => ({
      model: "openai/gpt-5.2",
      source: "runtime-fallback",
    }),
    normalizeFallbackModels: (models: string | string[] | undefined) =>
      typeof models === "string" ? [models] : models,
  }));

  moduleImportCounter += 1;
  ({ createContextWindowFallbackHook } = await import(`./index?test=${moduleImportCounter}`));
}

describe("context-window-fallback integration", () => {
  beforeEach(async () => {
    promptAsyncMock.mockClear();
    showToastMock.mockClear();
    sessionState?._resetForTesting();
    await prepareContextWindowFallbackModule();
  });

  afterEach(async () => {
    sessionState?._resetForTesting();
    await restoreActualContextWindowFallbackDependencies();
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
