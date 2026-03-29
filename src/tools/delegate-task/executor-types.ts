import type { BackgroundManager } from "../../features/background-agent"
import type { CategoriesConfig, GitMasterConfig, BrowserAutomationProvider, AgentOverrides } from "../../config/schema"
import type { OpencodeClient } from "./types"

export interface ExecutorContext {
  manager: BackgroundManager
  client: OpencodeClient
  directory: string
  /**
   * Test hook: bypass global connected providers cache reads.
   * `null` means "cache not populated yet".
   */
  connectedProvidersOverride?: string[] | null
  /**
   * Test hook: bypass model availability discovery.
   */
  availableModelsOverride?: Set<string>
  userCategories?: CategoriesConfig
  gitMasterConfig?: GitMasterConfig
  sisyphusJuniorModel?: string
  browserProvider?: BrowserAutomationProvider
  agentOverrides?: AgentOverrides
  onSyncSessionCreated?: (event: { sessionID: string; parentID: string; title: string }) => Promise<void>
  syncPollTimeoutMs?: number
}

export interface ParentContext {
  sessionID: string
  messageID: string
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
}

export interface SessionMessage {
  info?: {
    id?: string
    role?: string
    time?: { created?: number }
    finish?: string
    agent?: string
    model?: { providerID: string; modelID: string; variant?: string }
    modelID?: string
    providerID?: string
    variant?: string
  }
  parts?: Array<{ type?: string; text?: string }>
}
