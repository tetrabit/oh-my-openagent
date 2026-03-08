import type { CallOmoAgentArgs } from "./types"
import type { AgentOverrides, CategoriesConfig } from "../../config/schema"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { PluginInput } from "@opencode-ai/plugin"
import { log } from "../../shared"
import { getAgentToolRestrictions } from "../../shared"
import { createOrGetSession } from "./session-creator"
import { waitForCompletion } from "./completion-poller"
import { processMessages } from "./message-processor"
import { promptWithModelSuggestionRetry } from "../../shared/model-suggestion-retry"
import { sendPromptWithFallbackRetry } from "../../shared/prompt-fallback-retry"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { setSessionModel } from "../../shared/session-model-state"
import { setSessionAgent } from "../../features/claude-code-session-state"
import { setSessionFallbackChain } from "../../hooks/model-fallback/hook"
import { resolveConfiguredFallbackChain } from "../../shared/model-resolver"

type ExecuteSyncDeps = {
  createOrGetSession: typeof createOrGetSession
  waitForCompletion: typeof waitForCompletion
  processMessages: typeof processMessages
  promptWithModelSuggestionRetry?: typeof promptWithModelSuggestionRetry
}

const defaultDeps: ExecuteSyncDeps = {
  createOrGetSession,
  waitForCompletion,
  processMessages,
  promptWithModelSuggestionRetry,
}

type ExecuteSyncOptions = {
  agentOverrides?: AgentOverrides
  userCategories?: CategoriesConfig
  fallbackChain?: FallbackEntry[]
}

export async function executeSync(
  args: CallOmoAgentArgs,
  toolContext: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  },
  ctx: PluginInput,
  deps: ExecuteSyncDeps = defaultDeps,
  options: ExecuteSyncOptions = {},
): Promise<string> {
  const { sessionID } = await deps.createOrGetSession(args, toolContext, ctx)
  const agentConfigKey = getAgentConfigKey(args.subagent_type)
  const agentOverride = options.agentOverrides?.[agentConfigKey as keyof typeof options.agentOverrides]
  const fallbackChain = options.fallbackChain ?? resolveConfiguredFallbackChain({
    configuredFallbackModels: agentOverride?.fallback_models,
    categoryConfiguredFallbackModels: agentOverride?.category
      ? options.userCategories?.[agentOverride.category]?.fallback_models
      : undefined,
  })
  setSessionAgent(sessionID, args.subagent_type)
  setSessionFallbackChain(sessionID, fallbackChain)

  await toolContext.metadata?.({
    title: args.description,
    metadata: { sessionId: sessionID },
  })

  log(`[call_omo_agent] Sending prompt to session ${sessionID}`)
  log(`[call_omo_agent] Prompt text:`, args.prompt.substring(0, 100))

  try {
    const promptResult = await sendPromptWithFallbackRetry({
      promptArgs: {
        path: { id: sessionID },
        body: {
          agent: args.subagent_type,
          tools: {
            ...getAgentToolRestrictions(args.subagent_type),
            task: false,
            question: false,
          },
          parts: [{ type: "text", text: args.prompt }],
        },
      },
      fallbackChain,
      sendPrompt: (nextPromptArgs) =>
        (deps.promptWithModelSuggestionRetry ?? promptWithModelSuggestionRetry)(ctx.client as any, nextPromptArgs),
    })
    if (promptResult.usedFallback && promptResult.providerID && promptResult.modelID) {
      setSessionModel(sessionID, {
        providerID: promptResult.providerID,
        modelID: promptResult.modelID,
      })
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log(`[call_omo_agent] Prompt error:`, errorMessage)
    if (errorMessage.includes("agent.name") || errorMessage.includes("undefined")) {
      return `Error: Agent "${args.subagent_type}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.\n\n<task_metadata>\nsession_id: ${sessionID}\n</task_metadata>`
    }
    return `Error: Failed to send prompt: ${errorMessage}\n\n<task_metadata>\nsession_id: ${sessionID}\n</task_metadata>`
  }

  await deps.waitForCompletion(sessionID, toolContext, ctx)

  const responseText = await deps.processMessages(sessionID, ctx)

  const output =
    responseText + "\n\n" + ["<task_metadata>", `session_id: ${sessionID}`, "</task_metadata>"].join("\n")

  return output
}
