import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { extractStatusCode, extractErrorName, classifyErrorType, isAbortLikeError, isRetryableError } from "./error-classifier"
import { createFallbackState, prepareFallback } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

export function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  const {
    config,
    pluginConfig,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts,
    sessionTokenRefreshRetryCounts,
  } = deps

  const handleSessionCreated = (props: Record<string, unknown> | undefined) => {
    const sessionInfo = props?.info as { id?: string; model?: string } | undefined
    const sessionID = sessionInfo?.id
    const model = sessionInfo?.model

    if (sessionID && model) {
      log(`[${HOOK_NAME}] Session created with model`, { sessionID, model })
      sessionStates.set(sessionID, createFallbackState(model))
      sessionLastAccess.set(sessionID, Date.now())
    }
  }

  const handleSessionDeleted = (props: Record<string, unknown> | undefined) => {
    const sessionInfo = props?.info as { id?: string } | undefined
    const sessionID = sessionInfo?.id

    if (sessionID) {
      log(`[${HOOK_NAME}] Cleaning up session state`, { sessionID })
      sessionStates.delete(sessionID)
      sessionLastAccess.delete(sessionID)
      sessionRetryInFlight.delete(sessionID)
      sessionAwaitingFallbackResult.delete(sessionID)
      helpers.clearSessionFallbackTimeout(sessionID)
      sessionTokenRefreshRetryCounts.delete(sessionID)
      SessionCategoryRegistry.remove(sessionID)
    }
  }

  const handleSessionStop = async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    helpers.clearSessionFallbackTimeout(sessionID)

    if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
      await helpers.abortSessionRequest(sessionID, "session.stop")
    }

    sessionRetryInFlight.delete(sessionID)
    sessionAwaitingFallbackResult.delete(sessionID)
    sessionTokenRefreshRetryCounts.delete(sessionID)

    const state = sessionStates.get(sessionID)
    if (state?.pendingFallbackModel) {
      state.pendingFallbackModel = undefined
    }

    log(`[${HOOK_NAME}] Cleared fallback retry state on session.stop`, { sessionID })
  }

  const handleSessionIdle = (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    const awaitingFallbackResult = sessionAwaitingFallbackResult.has(sessionID)
    const hadTimeout = sessionFallbackTimeouts.has(sessionID)
    if (awaitingFallbackResult && hadTimeout) {
      log(`[${HOOK_NAME}] session.idle while awaiting fallback result; keeping timeout armed`, { sessionID })
      return
    }

    helpers.clearSessionFallbackTimeout(sessionID)
    sessionRetryInFlight.delete(sessionID)
    sessionAwaitingFallbackResult.delete(sessionID)
    sessionTokenRefreshRetryCounts.delete(sessionID)

    const state = sessionStates.get(sessionID)
    if (state?.pendingFallbackModel) {
      state.pendingFallbackModel = undefined
    }

    if (hadTimeout) {
      log(`[${HOOK_NAME}] Cleared fallback timeout after session completion`, { sessionID })
    }
  }

  const handleSessionError = async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    const error = props?.error
    const originalError = props?.originalError
    const agent = props?.agent as string | undefined

    if (!sessionID) {
      log(`[${HOOK_NAME}] session.error without sessionID, skipping`)
      return
    }

    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
    const effectiveError = originalError || error
    const usedOriginal = originalError !== undefined

    const wasAwaitingFallbackResult = sessionAwaitingFallbackResult.has(sessionID)
    if (wasAwaitingFallbackResult && !usedOriginal && isAbortLikeError(effectiveError)) {
      log(`[${HOOK_NAME}] Ignoring abort error while awaiting fallback result`, {
        sessionID,
        errorName: extractErrorName(effectiveError),
      })
      return
    }

    if (sessionRetryInFlight.has(sessionID)) {
      if (!wasAwaitingFallbackResult) {
        log(`[${HOOK_NAME}] session.error skipped — retry in flight`, {
          sessionID,
          retryInFlight: true,
        })
        return
      }

      log(`[${HOOK_NAME}] Processing session.error while awaiting fallback result`, {
        sessionID,
        retryInFlight: true,
      })
      sessionRetryInFlight.delete(sessionID)
      const existingState = sessionStates.get(sessionID)
      if (existingState?.pendingFallbackModel) {
        existingState.pendingFallbackModel = undefined
      }
    }

    sessionAwaitingFallbackResult.delete(sessionID)
    helpers.clearSessionFallbackTimeout(sessionID)
    const statusCode = extractStatusCode(effectiveError, config.retry_on_errors)
    const errorName = extractErrorName(effectiveError)
    const errorType = classifyErrorType(effectiveError)

    log(`[${HOOK_NAME}] session.error received`, {
      sessionID,
      agent,
      resolvedAgent,
      statusCode,
      errorName,
      errorType,
      usedOriginalError: usedOriginal,
    })

    let state = sessionStates.get(sessionID)

    if (!state) {
      const currentModel = props?.model as string | undefined
      if (currentModel) {
        state = createFallbackState(currentModel)
        sessionStates.set(sessionID, state)
        sessionLastAccess.set(sessionID, Date.now())
      } else {
        const detectedAgent = resolvedAgent
        const agentConfig = detectedAgent
          ? pluginConfig?.agents?.[detectedAgent as keyof typeof pluginConfig.agents]
          : undefined
        const agentModel = agentConfig?.model as string | undefined
        if (agentModel) {
          log(`[${HOOK_NAME}] Derived model from agent config`, { sessionID, agent: detectedAgent, model: agentModel })
          state = createFallbackState(agentModel)
          sessionStates.set(sessionID, state)
          sessionLastAccess.set(sessionID, Date.now())
        } else {
          log(`[${HOOK_NAME}] No model info available, cannot fallback`, { sessionID })
          return
        }
      }
    } else {
      sessionLastAccess.set(sessionID, Date.now())
    }

    if (errorType === "token_refresh_failed" && state?.currentModel) {
      const recoveryResult = await helpers.retryCurrentModelAfterTokenRefreshFailure(
        sessionID,
        state.currentModel,
        resolvedAgent,
        "session.error",
      )
      if (recoveryResult === "retry-dispatched") {
        return
      }
    } else {
      helpers.clearTokenRefreshRetryState(sessionID)
    }

    if (!isRetryableError(effectiveError, config.retry_on_errors)) {
      log(`[${HOOK_NAME}] Error not retryable, skipping fallback`, {
        sessionID,
        retryable: false,
        statusCode,
        errorName,
        errorType,
        usedOriginalError: usedOriginal,
      })
      return
    }

    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)

    if (fallbackModels.length === 0) {
      log(`[${HOOK_NAME}] No fallback models configured`, { sessionID, agent })
      return
    }

    if (!state) {
      log(`[${HOOK_NAME}] No model info available, cannot fallback`, { sessionID })
      return
    }

    const result = prepareFallback(sessionID, state, fallbackModels, config)

    if (result.success && config.notify_on_fallback) {
      await deps.ctx.client.tui
        .showToast({
          body: {
            title: "Model Fallback",
            message: `Switching to ${result.newModel?.split("/").pop() || result.newModel} for next request`,
            variant: "warning",
            duration: 5000,
          },
        })
        .catch(() => {})
    }

    if (result.success && result.newModel) {
      await helpers.autoRetryWithFallback(sessionID, result.newModel, resolvedAgent, "session.error")
    }

    if (!result.success) {
      log(`[${HOOK_NAME}] Fallback preparation failed`, { sessionID, error: result.error })
    }
  }

  const handleSessionStatus = async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    const status = props?.status as { type?: string; attempt?: number; message?: string; next?: number } | undefined

    if (!sessionID || status?.type !== "retry") {
      return
    }

    const retryMessage = typeof status.message === "string" ? status.message : ""
    const wasAwaitingFallbackResult = sessionAwaitingFallbackResult.has(sessionID)
    if (wasAwaitingFallbackResult) {
      helpers.clearSessionFallbackTimeout(sessionID)
    }

    sessionLastAccess.set(sessionID, Date.now())
    const state = sessionStates.get(sessionID)

    log(`[${HOOK_NAME}] Observed provider-managed retry in session.status; keeping current model`, {
      sessionID,
      model: state?.currentModel ?? (props?.model as string | undefined),
      attempt: status.attempt,
      next: status.next,
      message: retryMessage,
      awaitingFallbackResult: wasAwaitingFallbackResult,
    })
  }

  return async ({ event }: { event: { type: string; properties?: unknown } }) => {
    if (!config.enabled) return

    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.created") { handleSessionCreated(props); return }
    if (event.type === "session.deleted") { handleSessionDeleted(props); return }
    if (event.type === "session.stop") { await handleSessionStop(props); return }
    if (event.type === "session.idle") { handleSessionIdle(props); return }
    if (event.type === "session.error") { await handleSessionError(props); return }
    if (event.type === "session.status") { await handleSessionStatus(props); return }
  }
}
