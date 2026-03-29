import type { PluginInput } from "@opencode-ai/plugin"
import type { Client } from "./client"
import type { AutoCompactState, ParsedTokenLimitError } from "./types"
import type { ExperimentalConfig, OhMyOpenCodeConfig } from "../../config"
import * as parser from "./parser"
import * as executor from "./executor"
import * as deduplicationRecovery from "./deduplication-recovery"
import * as logger from "../../shared/logger"

export interface AnthropicContextWindowLimitRecoveryOptions {
  experimental?: ExperimentalConfig
  pluginConfig: OhMyOpenCodeConfig
}

function createRecoveryState(): AutoCompactState {
  return {
    pendingCompact: new Set<string>(),
    errorDataBySession: new Map<string, ParsedTokenLimitError>(),
    retryStateBySession: new Map(),
    truncateStateBySession: new Map(),
    emptyContentAttemptBySession: new Map(),
    compactionInProgress: new Set<string>(),
  }
}


export function createAnthropicContextWindowLimitRecoveryHook(
  ctx: PluginInput,
  options?: AnthropicContextWindowLimitRecoveryOptions,
) {
  const autoCompactState = createRecoveryState()
  const experimental = options?.experimental
  const pluginConfig = options?.pluginConfig!
  const pendingCompactionTimeoutBySession = new Map<string, ReturnType<typeof setTimeout>>()

  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined
      if (sessionInfo?.id) {
        const timeoutID = pendingCompactionTimeoutBySession.get(sessionInfo.id)
        if (timeoutID !== undefined) {
          clearTimeout(timeoutID)
          pendingCompactionTimeoutBySession.delete(sessionInfo.id)
        }

        autoCompactState.pendingCompact.delete(sessionInfo.id)
        autoCompactState.errorDataBySession.delete(sessionInfo.id)
        autoCompactState.retryStateBySession.delete(sessionInfo.id)
        autoCompactState.truncateStateBySession.delete(sessionInfo.id)
        autoCompactState.emptyContentAttemptBySession.delete(sessionInfo.id)
        autoCompactState.compactionInProgress.delete(sessionInfo.id)
      }
      return
    }

    if (event.type === "session.error") {
      const sessionID = props?.sessionID as string | undefined
      logger.log("[auto-compact] session.error received", { sessionID, error: props?.error })
      if (!sessionID) return

      const parsed = parser.parseAnthropicTokenLimitError(props?.error)
      logger.log("[auto-compact] parsed result", { parsed, hasError: !!props?.error })
      if (parsed) {
        autoCompactState.pendingCompact.add(sessionID)
        autoCompactState.errorDataBySession.set(sessionID, parsed)

        if (autoCompactState.compactionInProgress.has(sessionID)) {
          await deduplicationRecovery.attemptDeduplicationRecovery(sessionID, parsed, experimental, ctx.client)
          return
        }

        const lastAssistant = await executor.getLastAssistant(sessionID, ctx.client, ctx.directory)
        const lastAssistantInfo = lastAssistant?.info
        const providerID = parsed.providerID ?? (lastAssistantInfo?.providerID as string | undefined)
        const modelID = parsed.modelID ?? (lastAssistantInfo?.modelID as string | undefined)

        await ctx.client.tui
          .showToast({
            body: {
              title: "Context Limit Hit",
              message: "Truncating large tool outputs and recovering...",
              variant: "warning" as const,
              duration: 3000,
            },
          })
          .catch(() => {})

        const timeoutID = setTimeout(() => {
          pendingCompactionTimeoutBySession.delete(sessionID)
          executor.executeCompact(
            sessionID,
            { providerID, modelID },
            autoCompactState,
            ctx.client as Client,
            ctx.directory,
            pluginConfig,
            experimental,
          )
        }, 300)

        pendingCompactionTimeoutBySession.set(sessionID, timeoutID)
      }
      return
    }

    if (event.type === "message.updated") {
      const info = props?.info as Record<string, unknown> | undefined
      const sessionID = info?.sessionID as string | undefined

      if (sessionID && info?.role === "assistant" && info.error) {
        logger.log("[auto-compact] message.updated with error", { sessionID, error: info.error })
        const parsed = parser.parseAnthropicTokenLimitError(info.error)
        logger.log("[auto-compact] message.updated parsed result", { parsed })
        if (parsed) {
          parsed.providerID = info.providerID as string | undefined
          parsed.modelID = info.modelID as string | undefined
          autoCompactState.pendingCompact.add(sessionID)
          autoCompactState.errorDataBySession.set(sessionID, parsed)
        }
      }
      return
    }

    if (event.type === "session.idle") {
      const sessionID = props?.sessionID as string | undefined
      if (!sessionID) return

      if (!autoCompactState.pendingCompact.has(sessionID)) return

      const timeoutID = pendingCompactionTimeoutBySession.get(sessionID)
      if (timeoutID !== undefined) {
        clearTimeout(timeoutID)
        pendingCompactionTimeoutBySession.delete(sessionID)
      }

      const errorData = autoCompactState.errorDataBySession.get(sessionID)
      const lastAssistant = await executor.getLastAssistant(sessionID, ctx.client, ctx.directory)
      const lastAssistantInfo = lastAssistant?.info

      if (lastAssistantInfo?.summary === true && lastAssistant?.hasContent) {
        autoCompactState.pendingCompact.delete(sessionID)
        return
      }

      const providerID = errorData?.providerID ?? (lastAssistantInfo?.providerID as string | undefined)
      const modelID = errorData?.modelID ?? (lastAssistantInfo?.modelID as string | undefined)

      await ctx.client.tui
        .showToast({
          body: {
            title: "Auto Compact",
            message: "Token limit exceeded. Attempting recovery...",
            variant: "warning" as const,
            duration: 3000,
          },
        })
        .catch(() => {})

      await executor.executeCompact(
        sessionID,
        { providerID, modelID },
        autoCompactState,
        ctx.client as Client,
        ctx.directory,
        pluginConfig,
        experimental,
      )
    }
  }

  return {
    event: eventHandler,
  }
}
