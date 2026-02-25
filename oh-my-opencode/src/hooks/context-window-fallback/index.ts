import type { PluginContext } from "../../plugin/types";
import { resolveRuntimeFallback } from "../../shared/model-resolver";
import type { FallbackState } from "./types";

const MAX_FALLBACK_ATTEMPTS = 3;
const FALLBACK_COOLDOWN_MS = 5000;

function isContextOverflowError(error: any): boolean {
  return error && error.name === "ContextOverflowError";
}

function parseOverflowInfo(error: any) {
  return {
    providerID: error.data?.providerID ?? "unknown",
    modelID: error.data?.modelID ?? "unknown",
    currentTokens: error.data?.currentTokens,
    maxTokens: error.data?.maxTokens,
  };
}

async function getSessionAgent(client: any, sessionID: string): Promise<string> {
  try {
    const resp = await client.session.get({ path: { id: sessionID } });
    return resp?.data?.agent ?? "unspecified-high";
  } catch {
    return "unspecified-high";
  }
}

function trackTriedModel(state: FallbackState, sessionID: string, providerID: string, modelID: string) {
  if (!state.triedModels.has(sessionID)) {
    state.triedModels.set(sessionID, new Set());
  }
  state.triedModels.get(sessionID)!.add(`${providerID}/${modelID}`);
  state.lastFallbackTime.set(sessionID, Date.now());
}

export function createContextWindowFallbackHook(ctx: PluginContext): any {
  const state: FallbackState = {
    triedModels: new Map(),
    fallbackInProgress: new Set(),
    lastFallbackTime: new Map(),
  };

  return {
    event: async ({ event }: any) => {
      if (event.type === "session.deleted" || (event.type === "session.status" && event.properties.status === "idle")) {
        const sid = event.properties.sessionID;
        if (sid && !state.fallbackInProgress.has(sid)) {
          state.triedModels.delete(sid);
          state.lastFallbackTime.delete(sid);
        }
      }

      if (event.type !== "session.error") return;

      const error = event.properties.error;
      if (!isContextOverflowError(error)) return;

      const sessionID = event.properties.sessionID;
      if (!sessionID) return;
      if (state.fallbackInProgress.has(sessionID)) return;

      const tried = state.triedModels.get(sessionID) ?? new Set();
      if (tried.size >= MAX_FALLBACK_ATTEMPTS) {
        return; // Max attempts reached
      }

      const lastTime = state.lastFallbackTime.get(sessionID) ?? 0;
      if (Date.now() - lastTime < FALLBACK_COOLDOWN_MS) {
        return; // Too soon
      }

      const overflowInfo = parseOverflowInfo(error);
      const agent = await getSessionAgent(ctx.client, sessionID);

      const fallback = resolveRuntimeFallback({
        currentModel: { providerID: overflowInfo.providerID, modelID: overflowInfo.modelID },
        agent,
        triedModels: tried,
        currentTokens: overflowInfo.currentTokens,
      });

      if (!fallback) {
        return;
      }

      state.fallbackInProgress.add(sessionID);
      trackTriedModel(state, sessionID, overflowInfo.providerID, overflowInfo.modelID);

      try {
        await ctx.client.tui.showToast({
          body: {
            title: "Context Overflow",
            message: `Switching to ${fallback.providerID}/${fallback.modelID}`,
            variant: "info",
          },
        }).catch(() => {});

        await ctx.client.session.promptAsync({
          path: { id: sessionID },
          body: {
            model: { providerID: fallback.providerID, modelID: fallback.modelID },
            parts: [],
          },
        }).catch(() => {});
      } finally {
        state.fallbackInProgress.delete(sessionID);
      }
    },
  };
}
