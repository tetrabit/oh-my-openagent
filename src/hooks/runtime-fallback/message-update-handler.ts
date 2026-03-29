import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import {
  extractStatusCode,
  extractErrorName,
  classifyErrorType,
  isRetryableError,
  extractAutoRetrySignal,
  containsErrorContent,
} from "./error-classifier"
import { createFallbackState } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { dispatchFallbackOnRetrySignal } from "./retry-signal-fallback"
import { hasVisibleAssistantResponse, inspectAssistantResponseActivity } from "./visible-assistant-response"

export { hasVisibleAssistantResponse, inspectAssistantResponseActivity } from "./visible-assistant-response"

export function createMessageUpdateHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  const {
    ctx,
    config,
    pluginConfig,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionStatusRetryKeys,
    sessionTokenRefreshRetryCounts,
  } = deps
  const inspectAssistantActivity = inspectAssistantResponseActivity(extractAutoRetrySignal)

  return async (props: Record<string, unknown> | undefined) => {
    const info = props?.info as Record<string, unknown> | undefined
    const sessionID = info?.sessionID as string | undefined
    const eventParts = props?.parts as Array<{ type?: string; text?: string }> | undefined
    const infoParts = info?.parts as Array<{ type?: string; text?: string }> | undefined
    const parts = eventParts && eventParts.length > 0 ? eventParts : infoParts
    const errorContentResult = containsErrorContent(parts)
    const hasStructuredMessageError = errorContentResult.hasError
    const retrySignalResult = extractAutoRetrySignal(info)
    const partsText = (parts ?? [])
      .filter((part) => typeof part?.text === "string")
      .map((part) => (part.text ?? "").trim())
      .filter((text) => text.length > 0)
      .join("\n")
    const retrySignalFromParts = !hasStructuredMessageError && partsText
      ? extractAutoRetrySignal({ message: partsText, status: partsText, summary: partsText })?.signal
      : undefined
    const retrySignal = retrySignalResult?.signal ?? retrySignalFromParts
    const error = info?.error ??
      (errorContentResult.hasError
        ? { name: "MessageContentError", message: errorContentResult.errorMessage || "Message contains error content" }
        : undefined)
    const role = info?.role as string | undefined
    const model = info?.model as string | undefined

    if (sessionID && role === "assistant" && !error) {
      if (!sessionAwaitingFallbackResult.has(sessionID)) {
        return
      }

      if (retrySignal) {
        helpers.clearSessionFallbackTimeout(sessionID)
        await dispatchFallbackOnRetrySignal(deps, helpers, {
          sessionID,
          model,
          agent: info?.agent as string | undefined,
          source: "message.updated",
        })
        return
      }

      const activity = await inspectAssistantActivity(ctx, sessionID, parts)
      if (!activity.hasProgress) {
        log(`[${HOOK_NAME}] Assistant update observed without visible final response; keeping fallback timeout`, {
          sessionID,
          model,
        })
        return
      }

      sessionAwaitingFallbackResult.delete(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      sessionTokenRefreshRetryCounts.delete(sessionID)
      helpers.clearSessionFallbackTimeout(sessionID)
      const state = sessionStates.get(sessionID)
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined
      }
      log(`[${HOOK_NAME}] Assistant progress observed; cleared fallback timeout`, {
        sessionID,
        model,
        hasVisibleResponse: activity.hasVisibleResponse,
      })
      return
    }

    if (sessionID && role === "assistant" && error) {
      const wasAwaitingFallbackResult = sessionAwaitingFallbackResult.has(sessionID)
      if (retrySignal && !hasStructuredMessageError) {
        helpers.clearSessionFallbackTimeout(sessionID)
        await dispatchFallbackOnRetrySignal(deps, helpers, {
          sessionID,
          model,
          agent: info?.agent as string | undefined,
          source: "message.updated",
        })
        return
      }

      sessionAwaitingFallbackResult.delete(sessionID)
      if (sessionRetryInFlight.has(sessionID)) {
        log(`[${HOOK_NAME}] message.updated fallback skipped (retry in flight)`, { sessionID })
        return
      }

      helpers.clearSessionFallbackTimeout(sessionID)
      const statusCode = extractStatusCode(error, config.retry_on_errors)
      const errorName = extractErrorName(error)
      const errorType = classifyErrorType(error)

      log(`[${HOOK_NAME}] message.updated with assistant error`, {
        sessionID,
        model,
        statusCode,
        errorName,
        errorType,
      })

      let state = sessionStates.get(sessionID)
      const agent = info?.agent as string | undefined
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)

      if (!state) {
        const initialModel = resolveFallbackBootstrapModel({
          sessionID,
          source: "message.updated",
          eventModel: model,
          resolvedAgent,
          pluginConfig,
        })

        if (initialModel) {
          state = createFallbackState(initialModel)
          sessionStates.set(sessionID, state)
          sessionLastAccess.set(sessionID, Date.now())
        }
      } else {
        sessionLastAccess.set(sessionID, Date.now())
      }

      if (errorType === "token_refresh_failed" && state?.currentModel) {
        const recoveryResult = await helpers.retryCurrentModelAfterTokenRefreshFailure(
          sessionID,
          state.currentModel,
          resolvedAgent,
          "message.updated",
        )
        if (recoveryResult === "retry-dispatched") {
          return
        }
      } else {
        helpers.clearTokenRefreshRetryState(sessionID)
      }

      if (!isRetryableError(error, config.retry_on_errors)) {
        log(`[${HOOK_NAME}] message.updated error not retryable, skipping fallback`, {
          sessionID,
          statusCode,
          errorName,
          errorType,
        })
        return
      }

      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)

      if (fallbackModels.length === 0) {
        return
      }

      if (!state) {
        log(`[${HOOK_NAME}] message.updated missing model info, cannot fallback`, {
          sessionID,
          errorName,
          errorType,
        })
        return
      }

      if (state.pendingFallbackModel) {
        if (wasAwaitingFallbackResult) {
          log(`[${HOOK_NAME}] Clearing pending fallback after assistant error while awaiting fallback result`, {
            sessionID,
            pendingFallbackModel: state.pendingFallbackModel,
          })
          state.pendingFallbackModel = undefined
        } else {
          log(`[${HOOK_NAME}] message.updated fallback skipped (pending fallback in progress)`, {
            sessionID,
            pendingFallbackModel: state.pendingFallbackModel,
          })
          return
        }
      }

      await dispatchFallbackRetry(deps, helpers, {
        sessionID,
        state,
        fallbackModels,
        resolvedAgent,
        source: "message.updated",
      })
    }
  }
}
