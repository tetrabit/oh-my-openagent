import type { PluginInput } from "@opencode-ai/plugin";
import { getSessionAgent } from "../../features/claude-code-session-state";
import { parseAnthropicTokenLimitError } from "../anthropic-context-window-limit-recovery";
import * as modelAvailability from "../../shared/model-availability";
import * as modelResolver from "../../shared/model-resolver";
import { log } from "../../shared/logger";

const MAX_FALLBACK_ATTEMPTS = 3;
const FALLBACK_COOLDOWN_MS = 5_000;
const VERBOSE_DEBUG = process.env.OMO_CONTEXT_FALLBACK_DEBUG === "1";
const RATE_LIMIT_PATTERNS = [
  /this request would exceed your account.?s rate limit/i,
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /quota exceeded/i,
  /insufficient[_\s-]?quota/i,
  /account.?s rate limit/i,
];

export type FallbackReason = "context_overflow" | "rate_limit";

interface OverflowData {
  providerID?: string;
  modelID?: string;
  currentTokens?: number;
  maxTokens?: number;
  message?: string;
}

interface SessionMessageModel {
  providerID?: string;
  modelID?: string;
}

interface SessionMessageInfo {
  role?: string;
  providerID?: string;
  modelID?: string;
  model?: SessionMessageModel;
}

interface SessionMessage {
  info?: SessionMessageInfo;
}

interface FallbackState {
  fallbackInProgress: Set<string>;
  triedModelsBySession: Map<string, Set<string>>;
  fallbackAttemptsBySession: Map<string, number>;
  lastFallbackAtBySession: Map<string, number>;
}

function debugLog(message: string, data?: Record<string, unknown>): void {
  if (!VERBOSE_DEBUG) return;

  log(message, {
    ...data,
    stack: new Error("context-window-fallback trace").stack,
  });
}

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

function hasModel(set: Set<string>, model: string): boolean {
  const normalized = normalizeModelKey(model);
  for (const item of set) {
    if (normalizeModelKey(item) === normalized) return true;
  }
  return false;
}

function splitModel(fullModel: string):
  | { providerID: string; modelID: string }
  | undefined {
  const idx = fullModel.indexOf("/");
  if (idx <= 0 || idx >= fullModel.length - 1) return undefined;

  const providerID = fullModel.slice(0, idx).trim();
  const modelID = fullModel.slice(idx + 1).trim();
  if (!providerID || !modelID) return undefined;

  return { providerID, modelID };
}

function getOrCreateTriedModels(
  state: FallbackState,
  sessionID: string,
): Set<string> {
  let tried = state.triedModelsBySession.get(sessionID);
  if (!tried) {
    tried = new Set<string>();
    state.triedModelsBySession.set(sessionID, tried);
  }
  return tried;
}

function cleanupSessionState(state: FallbackState, sessionID: string): void {
  state.fallbackInProgress.delete(sessionID);
  state.triedModelsBySession.delete(sessionID);
  state.fallbackAttemptsBySession.delete(sessionID);
  state.lastFallbackAtBySession.delete(sessionID);
}

function extractErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";

  const err = error as Record<string, unknown>;
  if (typeof err.message === "string") return err.message;

  const data = err.data;
  if (data && typeof data === "object") {
    const dataRecord = data as Record<string, unknown>;
    if (typeof dataRecord.message === "string") return dataRecord.message;
    const nestedError = dataRecord.error;
    if (nestedError && typeof nestedError === "object") {
      const nested = nestedError as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
  }

  const nestedError = err.error;
  if (nestedError && typeof nestedError === "object") {
    const nested = nestedError as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
  }

  return "";
}

function isContextOverflowError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;
  if (err.name === "ContextOverflowError") return true;

  const parsed = parseAnthropicTokenLimitError(error);
  if (parsed) return true;

  const message = extractErrorMessage(error).toLowerCase();
  if (!message) return false;

  const mentionsTokens =
    message.includes("token") ||
    message.includes("context") ||
    message.includes("prompt is too long");

  const mentionsLimit =
    message.includes("limit") ||
    message.includes("maximum") ||
    message.includes("exceed") ||
    message.includes("too long") ||
    message.includes("overflow");

  return mentionsTokens && mentionsLimit;
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;
  const data = err.data && typeof err.data === "object" ? (err.data as Record<string, unknown>) : undefined;

  const message = extractErrorMessage(error);
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }

  const statusCode = toOptionalNumber(data?.statusCode ?? err.statusCode);
  if (statusCode === 429) return true;

  const responseBody =
    typeof data?.responseBody === "string"
      ? data.responseBody
      : typeof err.responseBody === "string"
        ? err.responseBody
        : "";

  if (responseBody) {
    const lower = responseBody.toLowerCase();
    if (
      lower.includes("rate_limit") ||
      lower.includes("too_many_requests") ||
      lower.includes("insufficient_quota") ||
      lower.includes("quota exceeded")
    ) {
      return true;
    }
  }

  return false;
}

export function detectFallbackReason(error: unknown): FallbackReason | null {
  if (isContextOverflowError(error)) return "context_overflow";
  if (isRateLimitError(error)) return "rate_limit";
  return null;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.replace(/,/g, ""), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractOverflowData(error: unknown): OverflowData {
  const result: OverflowData = {};

  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    if (typeof err.message === "string") result.message = err.message;
    if (typeof err.providerID === "string") result.providerID = err.providerID;
    if (typeof err.modelID === "string") result.modelID = err.modelID;
    result.currentTokens = toOptionalNumber(err.currentTokens);
    result.maxTokens = toOptionalNumber(err.maxTokens);

    const data = err.data;
    if (data && typeof data === "object") {
      const dataRecord = data as Record<string, unknown>;
      if (!result.message && typeof dataRecord.message === "string") result.message = dataRecord.message;
      if (!result.providerID && typeof dataRecord.providerID === "string") result.providerID = dataRecord.providerID;
      if (!result.modelID && typeof dataRecord.modelID === "string") result.modelID = dataRecord.modelID;
      if (result.currentTokens === undefined) result.currentTokens = toOptionalNumber(dataRecord.currentTokens);
      if (result.maxTokens === undefined) result.maxTokens = toOptionalNumber(dataRecord.maxTokens);
    }
  }

  const parsed = parseAnthropicTokenLimitError(error);
  if (parsed) {
    if (result.currentTokens === undefined && parsed.currentTokens > 0) {
      result.currentTokens = parsed.currentTokens;
    }
    if (result.maxTokens === undefined && parsed.maxTokens > 0) {
      result.maxTokens = parsed.maxTokens;
    }
    if (!result.providerID && parsed.providerID) result.providerID = parsed.providerID;
    if (!result.modelID && parsed.modelID) result.modelID = parsed.modelID;
  }

  return result;
}

async function getMostRecentModel(
  ctx: PluginInput,
  sessionID: string,
): Promise<string | undefined> {
  try {
    const response = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    });

    const payload = response as { data?: unknown };
    const direct = payload.data;
    const nested =
      direct && typeof direct === "object"
        ? (direct as Record<string, unknown>).data
        : undefined;

    const messages = Array.isArray(direct)
      ? (direct as SessionMessage[])
      : Array.isArray(nested)
        ? (nested as SessionMessage[])
        : [];

    debugLog("[context-window-fallback] session.messages parsed", {
      sessionID,
      messageCount: messages.length,
      usedNestedData: !Array.isArray(direct) && Array.isArray(nested),
    });

    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info;
      if (!info) continue;

      if (info.role === "assistant" && info.providerID && info.modelID) {
        return modelKey(info.providerID, info.modelID);
      }

      if (info.role === "user" && info.model?.providerID && info.model?.modelID) {
        return modelKey(info.model.providerID, info.model.modelID);
      }
    }

    return undefined;
  } catch (error) {
    log("[context-window-fallback] failed to read session messages", {
      sessionID,
      error: String(error),
    });
    return undefined;
  }
}

export function createContextWindowFallbackHook(ctx: PluginInput) {
  const state: FallbackState = {
    fallbackInProgress: new Set<string>(),
    triedModelsBySession: new Map<string, Set<string>>(),
    fallbackAttemptsBySession: new Map<string, number>(),
    lastFallbackAtBySession: new Map<string, number>(),
  };

  const event = async ({
    event,
  }: {
    event: { type: string; properties?: unknown };
  }): Promise<boolean> => {
    const props = event.properties as Record<string, unknown> | undefined;

    debugLog("[context-window-fallback] event received", {
      type: event.type,
      hasProps: !!props,
      sessionID: typeof props?.sessionID === "string" ? props.sessionID : undefined,
      errorName:
        props && typeof props.error === "object" && props.error && "name" in (props.error as Record<string, unknown>)
          ? (props.error as Record<string, unknown>).name
          : undefined,
      errorMessage: extractErrorMessage(props?.error),
    });

    if (event.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined;
      if (sessionInfo?.id) cleanupSessionState(state, sessionInfo.id);
      debugLog("[context-window-fallback] session.deleted cleanup", {
        sessionID: sessionInfo?.id,
      });
      return false;
    }

    if (event.type === "session.idle") {
      const sessionID = props?.sessionID as string | undefined;
      if (sessionID && !state.fallbackInProgress.has(sessionID)) {
        cleanupSessionState(state, sessionID);
        debugLog("[context-window-fallback] session.idle cleanup", {
          sessionID,
        });
      }
      return false;
    }

    if (event.type !== "session.error") {
      debugLog("[context-window-fallback] ignored non-session.error event", {
        type: event.type,
      });
      return false;
    }

    const sessionID = props?.sessionID as string | undefined;
    if (!sessionID) {
      debugLog("[context-window-fallback] missing sessionID in session.error", {
        props,
      });
      return false;
    }

    const rawError = props?.error;
    const reason = detectFallbackReason(rawError);
    if (!reason) {
      debugLog("[context-window-fallback] error not eligible for fallback", {
        sessionID,
        errorName:
          rawError && typeof rawError === "object" && "name" in (rawError as Record<string, unknown>)
            ? (rawError as Record<string, unknown>).name
            : undefined,
        errorMessage: extractErrorMessage(rawError),
      });
      return false;
    }

    if (state.fallbackInProgress.has(sessionID)) {
      debugLog("[context-window-fallback] fallback already in progress", {
        sessionID,
      });
      return true;
    }

    const now = Date.now();
    const attempts = state.fallbackAttemptsBySession.get(sessionID) ?? 0;
    if (attempts >= MAX_FALLBACK_ATTEMPTS) {
      log("[context-window-fallback] max fallback attempts reached", {
        sessionID,
        attempts,
      });
      debugLog("[context-window-fallback] blocked by max attempts", {
        sessionID,
        attempts,
      });
      return false;
    }

    const lastFallbackAt = state.lastFallbackAtBySession.get(sessionID) ?? 0;
    if (now - lastFallbackAt < FALLBACK_COOLDOWN_MS) {
      debugLog("[context-window-fallback] blocked by cooldown", {
        sessionID,
        now,
        lastFallbackAt,
        cooldownMs: FALLBACK_COOLDOWN_MS,
      });
      return false;
    }

    const overflow = extractOverflowData(rawError);
    let currentModel: string | undefined;

    if (overflow.providerID && overflow.modelID) {
      currentModel = modelKey(overflow.providerID, overflow.modelID);
    }

    if (!currentModel) {
      currentModel = await getMostRecentModel(ctx, sessionID);
    }

    if (!currentModel) {
      log("[context-window-fallback] could not determine current model", {
        sessionID,
      });
      debugLog("[context-window-fallback] unable to detect current model", {
        sessionID,
        errorMessage: extractErrorMessage(rawError),
      });
      return false;
    }

    const triedModels = getOrCreateTriedModels(state, sessionID);
    if (!hasModel(triedModels, currentModel)) {
      triedModels.add(currentModel);
    }

    const availableModels = await modelAvailability.fetchAvailableModels();
    const agent = getSessionAgent(sessionID);

    debugLog("[context-window-fallback] resolving runtime fallback", {
      sessionID,
      reason,
      currentModel,
      agent,
      availableModelsCount: availableModels.size,
      triedCount: triedModels.size,
      requiredTokens: reason === "context_overflow" ? overflow.currentTokens : undefined,
      parsedError: overflow,
    });

    const fallback = modelResolver.resolveRuntimeFallback({
      currentModel,
      agent,
      availableModels,
      triedModels,
      requiredTokens: reason === "context_overflow" ? overflow.currentTokens : undefined,
      reason,
    });

    if (!fallback) {
      log("[context-window-fallback] no runtime fallback available", {
        sessionID,
        currentModel,
        agent,
        availableModelsCount: availableModels.size,
        reason,
      });
      debugLog("[context-window-fallback] fallback resolution returned undefined", {
        sessionID,
        currentModel,
        agent,
        reason,
        availableModels: Array.from(availableModels).slice(0, 30),
      });
      return false;
    }

    const parsedFallback = splitModel(fallback.model);
    if (!parsedFallback) {
      log("[context-window-fallback] invalid fallback model format", {
        sessionID,
        model: fallback.model,
      });
      debugLog("[context-window-fallback] parsed fallback model invalid", {
        sessionID,
        model: fallback.model,
      });
      return false;
    }

    state.fallbackInProgress.add(sessionID);

    try {
      const detailSummary =
        reason === "context_overflow" && overflow.currentTokens && overflow.maxTokens
          ? ` (${overflow.currentTokens.toLocaleString()} > ${overflow.maxTokens.toLocaleString()} tokens)`
          : "";
      const reasonText = reason === "context_overflow" ? "Context overflow" : "Rate limit reached";

      await ctx.client.tui.showToast({
        body: {
          title: "Model Fallback",
          message: `${reasonText}${detailSummary}. Switching ${currentModel} -> ${fallback.model}`,
          variant: "warning",
          duration: 4000,
        },
      });

      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          auto: true,
          model: {
            providerID: parsedFallback.providerID,
            modelID: parsedFallback.modelID,
          },
        } as never,
        query: { directory: ctx.directory },
      });

      log("[context-window-fallback] fallback retry triggered", {
        sessionID,
        currentModel,
        fallbackModel: fallback.model,
        agent,
        requiredTokens: overflow.currentTokens,
        reason,
      });

      state.lastFallbackAtBySession.set(sessionID, now);
      state.fallbackAttemptsBySession.set(sessionID, attempts + 1);
      triedModels.add(fallback.model);

      debugLog("[context-window-fallback] promptAsync dispatched", {
        sessionID,
        currentModel,
        fallbackModel: fallback.model,
        parsedFallback,
        reason,
      });

      return true;
    } catch (error) {
      log("[context-window-fallback] fallback retry failed", {
        sessionID,
        currentModel,
        fallbackModel: fallback.model,
        error: String(error),
        reason,
      });

      debugLog("[context-window-fallback] promptAsync failed", {
        sessionID,
        currentModel,
        fallbackModel: fallback.model,
        reason,
        error: String(error),
      });

      try {
        await ctx.client.tui.showToast({
          body: {
            title: "Model Fallback Failed",
            message: "Automatic model switch failed. Falling back to compaction recovery.",
            variant: "warning",
            duration: 4000,
          },
        });
      } catch (toastError: unknown) {
        log("[context-window-fallback] failed to show fallback error toast", {
          sessionID,
          error: String(toastError),
        });
      }

      return false;
    } finally {
      state.fallbackInProgress.delete(sessionID);
    }
  };

  return {
    event,
  };
}
