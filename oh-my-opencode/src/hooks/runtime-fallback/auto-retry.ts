import type { HookDeps } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import {
  createInternalAgentTextPart,
  createPromptAttemptID,
  createSessionPromptSupersessionKey,
  resolveInheritedPromptTools,
  withPromptQueueControl,
} from "../../shared"
import { getAgentDisplayName } from "../../shared/agent-display-names"
import { normalizeAgentNameWithKnown, resolveAgentForSessionWithKnown } from "./agent-resolver"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { prepareFallback } from "./fallback-state"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import {
  createFallbackResumePrompt,
  findFallbackResumeAnchor,
  type FallbackResumeMessage,
} from "./resume-prompt"
import { getAnthropicStatusSnapshot, isDirectAnthropicModel } from "./anthropic-status"
import type { AnthropicStatusSnapshot } from "./anthropic-status"

const SESSION_TTL_MS = 30 * 60 * 1000
const TOKEN_REFRESH_RETRY_DELAYS_MS = [500, 1_500, 4_000, 8_000]
const TOKEN_REFRESH_RETRY_TOAST_BASE_DURATION_MS = 5_000

declare function setTimeout(callback: () => void | Promise<void>, delay?: number): ReturnType<typeof globalThis.setTimeout>
declare function clearTimeout(timeout: ReturnType<typeof globalThis.setTimeout>): void

export function createAutoRetryHelpers(deps: HookDeps) {
  const {
    ctx,
    config,
    options,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts,
    pluginConfig,
    sessionTokenRefreshRetryCounts,
  } = deps
  const configuredAgentNames = Object.keys(deps.pluginConfig?.agents ?? {})
  const anthropicStatusCache: {
    current?: {
      fetchedAt: number
      snapshot: AnthropicStatusSnapshot | undefined
    }
  } = {}

  const clearTokenRefreshRetryState = (sessionID: string) => {
    sessionTokenRefreshRetryCounts.delete(sessionID)
  }

  const showTokenRefreshRetryToast = async (
    model: string,
    attempt: number,
    delayMs: number,
    anthropicStatus: AnthropicStatusSnapshot | undefined,
  ): Promise<void> => {
    const modelLabel = model.split("/").pop() ?? model
    const delaySeconds = delayMs > 0 ? (delayMs / 1000).toFixed(delayMs % 1000 === 0 ? 0 : 1) : "0"
    const statusSuffix = anthropicStatus?.degraded
      ? ` Anthropic status: ${anthropicStatus.incidentName ?? anthropicStatus.description ?? "degraded"}.`
      : ""

    await ctx.client.tui.showToast({
      body: {
        title: "Token Refresh Retry",
        message: `Retrying ${modelLabel} in ${delaySeconds}s (attempt ${attempt}/${TOKEN_REFRESH_RETRY_DELAYS_MS.length}).${statusSuffix}`,
        variant: "warning",
        duration: Math.max(
          TOKEN_REFRESH_RETRY_TOAST_BASE_DURATION_MS,
          Math.min(delayMs + 3_000, 12_000),
        ),
      },
    }).catch(() => {})
  }

  const abortSessionRequest = async (sessionID: string, source: string): Promise<void> => {
    try {
      await ctx.client.session.abort({ path: { id: sessionID } })
      log(`[${HOOK_NAME}] Aborted in-flight session request (${source})`, { sessionID })
    } catch (error) {
      log(`[${HOOK_NAME}] Failed to abort in-flight session request (${source})`, {
        sessionID,
        error: String(error),
      })
    }
  }

  const clearSessionFallbackTimeout = (sessionID: string) => {
    const timer = sessionFallbackTimeouts.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      sessionFallbackTimeouts.delete(sessionID)
    }
  }

  const scheduleSessionFallbackTimeout = (sessionID: string, resolvedAgent?: string) => {
    clearSessionFallbackTimeout(sessionID)

    const timeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
    if (timeoutMs <= 0) return

    const timer = setTimeout(async () => {
      sessionFallbackTimeouts.delete(sessionID)

      const state = sessionStates.get(sessionID)
      if (!state) return

      if (sessionRetryInFlight.has(sessionID)) {
        log(`[${HOOK_NAME}] Overriding in-flight retry due to session timeout`, { sessionID })
      }

      await abortSessionRequest(sessionID, "session.timeout")
      sessionRetryInFlight.delete(sessionID)

      if (state.pendingFallbackModel) {
        state.pendingFallbackModel = undefined
      }

      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
      if (fallbackModels.length === 0) return

      log(`[${HOOK_NAME}] Session fallback timeout reached`, {
        sessionID,
        timeoutSeconds: config.timeout_seconds,
        currentModel: state.currentModel,
      })

      const result = prepareFallback(sessionID, state, fallbackModels, config)
      if (result.success && result.newModel) {
        await autoRetryWithFallback(sessionID, result.newModel, resolvedAgent, "session.timeout")
      } else {
        sessionAwaitingFallbackResult.delete(sessionID)
        log(`[${HOOK_NAME}] Fallback preparation failed after timeout; cleared awaiting state`, {
          sessionID,
          error: result.error,
          maxAttemptsReached: result.maxAttemptsReached,
        })
      }
    }, timeoutMs)

    sessionFallbackTimeouts.set(sessionID, timer)
  }

  const retrySessionWithModel = async (
    sessionID: string,
    model: string,
    resolvedAgent: string | undefined,
    source: string,
    preemptInFlightRequest = false,
  ): Promise<boolean> => {
    if (sessionRetryInFlight.has(sessionID)) {
      log(`[${HOOK_NAME}] Retry already in flight, skipping (${source})`, { sessionID })
      return false
    }

    const modelParts = model.split("/")
    if (modelParts.length < 2) {
      log(`[${HOOK_NAME}] Invalid model format (missing provider prefix): ${model}`)
      const state = sessionStates.get(sessionID)
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined
      }
      return false
    }

    const fallbackModelObj = {
      providerID: modelParts[0],
      modelID: modelParts.slice(1).join("/"),
    }

    sessionRetryInFlight.add(sessionID)
    let retryDispatched = false
    try {
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      const msgs = (messagesResp as { data?: FallbackResumeMessage[] }).data
      const anchor = Array.isArray(msgs) ? findFallbackResumeAnchor(msgs) : undefined
      const lastUserMsg = anchor?.message ?? msgs?.filter((m) => m.info?.role === "user").pop()
      const lastUserTools =
        typeof lastUserMsg?.info?.tools === "object" && lastUserMsg.info.tools !== null
          ? (lastUserMsg.info.tools as Record<string, boolean | "allow" | "deny" | "ask">)
          : undefined

      if (lastUserMsg) {
        log(`[${HOOK_NAME}] Auto-retrying session request (${source})`, {
          sessionID,
          model,
        })

        const retryAgent =
          (typeof lastUserMsg.info?.agent === "string" ? lastUserMsg.info.agent : undefined) ??
          getSessionAgent(sessionID) ??
          (resolvedAgent ? getAgentDisplayName(resolvedAgent) : undefined)
        const retryTools = resolveInheritedPromptTools(sessionID, lastUserTools)

        sessionAwaitingFallbackResult.add(sessionID)
        scheduleSessionFallbackTimeout(sessionID, resolvedAgent)

        if (preemptInFlightRequest) {
          await abortSessionRequest(sessionID, `${source}.preempt`)
        }

        await ctx.client.session.promptAsync(withPromptQueueControl({
          path: { id: sessionID },
          body: {
            ...(retryAgent ? { agent: retryAgent } : {}),
            ...(retryTools ? { tools: retryTools } : {}),
            model: fallbackModelObj,
            parts: [createInternalAgentTextPart(createFallbackResumePrompt(source, model, msgs))],
          },
          query: { directory: ctx.directory },
        }, {
          supersessionKey: createSessionPromptSupersessionKey(sessionID, "runtime-fallback"),
          attemptID: createPromptAttemptID(),
          supersedePending: "all",
        }))
        retryDispatched = true
      } else {
        log(`[${HOOK_NAME}] No user message found for auto-retry (${source})`, { sessionID })
      }
    } catch (retryError) {
      log(`[${HOOK_NAME}] Auto-retry failed (${source})`, { sessionID, error: String(retryError) })
    } finally {
      sessionRetryInFlight.delete(sessionID)
      if (!retryDispatched) {
        sessionAwaitingFallbackResult.delete(sessionID)
        clearSessionFallbackTimeout(sessionID)
        const state = sessionStates.get(sessionID)
        if (state?.pendingFallbackModel) {
          state.pendingFallbackModel = undefined
        }
      }
    }

    return retryDispatched
  }

  const autoRetryWithFallback = async (
    sessionID: string,
    newModel: string,
    resolvedAgent: string | undefined,
    source: string,
    preemptInFlightRequest = false,
  ): Promise<void> => {
    await retrySessionWithModel(sessionID, newModel, resolvedAgent, source, preemptInFlightRequest)
  }

  const retryCurrentModelAfterTokenRefreshFailure = async (
    sessionID: string,
    currentModel: string,
    resolvedAgent: string | undefined,
    source: string,
  ): Promise<"retry-dispatched" | "allow-fallback"> => {
    const completedAttempts = sessionTokenRefreshRetryCounts.get(sessionID) ?? 0
    if (completedAttempts >= TOKEN_REFRESH_RETRY_DELAYS_MS.length) {
      clearTokenRefreshRetryState(sessionID)
      log(`[${HOOK_NAME}] Token refresh retry budget exhausted; allowing fallback`, {
        sessionID,
        currentModel,
        retryBudget: TOKEN_REFRESH_RETRY_DELAYS_MS.length,
      })
      return "allow-fallback"
    }

    const attempt = completedAttempts + 1
    sessionTokenRefreshRetryCounts.set(sessionID, attempt)

    const anthropicStatus = isDirectAnthropicModel(currentModel)
      ? await getAnthropicStatusSnapshot(anthropicStatusCache)
      : undefined
    const delayMs = TOKEN_REFRESH_RETRY_DELAYS_MS[completedAttempts] ?? 0

    if (anthropicStatus?.degraded) {
      log(`[${HOOK_NAME}] Anthropic status indicates degraded service during token refresh retry`, {
        sessionID,
        currentModel,
        attempt,
        indicator: anthropicStatus.indicator,
        description: anthropicStatus.description,
        incidentName: anthropicStatus.incidentName,
        incidentStatus: anthropicStatus.incidentStatus,
        impactedComponents: anthropicStatus.impactedComponents,
      })
    }

    await showTokenRefreshRetryToast(currentModel, attempt, delayMs, anthropicStatus)

    if (delayMs > 0) {
      await Bun.sleep(delayMs)
    }

    const retryDispatched = await retrySessionWithModel(
      sessionID,
      currentModel,
      resolvedAgent,
      `${source}.token-refresh.${attempt}`,
      false,
    )

    if (!retryDispatched) {
      clearTokenRefreshRetryState(sessionID)
      return "allow-fallback"
    }

    return "retry-dispatched"
  }

  const resolveAgentForSessionFromContext = async (
    sessionID: string,
    eventAgent?: string,
  ): Promise<string | undefined> => {
    const resolved = resolveAgentForSessionWithKnown(sessionID, eventAgent, configuredAgentNames)
    if (resolved) return resolved

    try {
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      const msgs = (messagesResp as { data?: Array<{ info?: Record<string, unknown> }> }).data
      if (!msgs || msgs.length === 0) return undefined

      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i]?.info
        const infoAgent = typeof info?.agent === "string" ? info.agent : undefined
        const normalized = normalizeAgentNameWithKnown(infoAgent, configuredAgentNames)
        if (normalized) {
          return normalized
        }
      }
    } catch {
      return undefined
    }

    return undefined
  }

  const cleanupStaleSessions = () => {
    const now = Date.now()
    let cleanedCount = 0
    for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
      if (now - lastAccess > SESSION_TTL_MS) {
        sessionStates.delete(sessionID)
        sessionLastAccess.delete(sessionID)
        sessionRetryInFlight.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        clearSessionFallbackTimeout(sessionID)
        SessionCategoryRegistry.remove(sessionID)
        clearTokenRefreshRetryState(sessionID)
        cleanedCount++
      }
    }
    if (cleanedCount > 0) {
      log(`[${HOOK_NAME}] Cleaned up ${cleanedCount} stale session states`)
    }
  }

  return {
    abortSessionRequest,
    clearSessionFallbackTimeout,
    scheduleSessionFallbackTimeout,
    autoRetryWithFallback,
    retryCurrentModelAfterTokenRefreshFailure,
    clearTokenRefreshRetryState,
    resolveAgentForSessionFromContext,
    cleanupStaleSessions,
  }
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
