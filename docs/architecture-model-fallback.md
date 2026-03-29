# Architecture: Cross-Project Model Fallback System

**Date:** 2026-02-25
**Status:** Implementation In Progress
**Projects:** opencode-platform (core) ↔ oh-my-opencode (plugin)

---

## Problem Statement

When an AI model hits its context window limit during a session, the conversation stalls. The current recovery mechanism (truncate tool outputs → summarize) uses the **same model** that already overflowed. There is no runtime mechanism to automatically fall back to a model with a larger context window, retry the prompt, and seamlessly continue the session.

### User-Facing Behavior (Goal)

1. User is working in a session. The model hits its context window limit.
2. opencode surfaces a structured error: *"This message would utilize 245,000 tokens. The max for claude-sonnet-4-20250514 is 200,000."*
3. oh-my-opencode reads this signal, selects the next model from the agent's fallback chain (e.g. claude-sonnet → gpt-5.2 with 1M context), retries the last prompt automatically.
4. The input window updates to show the new model for subsequent messages.
5. A toast notification informs the user: *"Model switched: claude-sonnet-4-20250514 → gpt-5.2 (context window exceeded)"*

---

## Current Architecture

### Error Flow (Before Changes)

```
Provider returns "context too long" (varies by provider)
    ↓
ProviderError.parseAPICallError()
    → Matches against OVERFLOW_PATTERNS (12+ provider-specific regexes)
    → Returns {type: 'context_overflow', message: string, responseBody?: string}
    ↓
MessageV2.fromError()
    → Creates ContextOverflowError({message, responseBody?})
    ↓
processor.ts
    → Sets assistant.error = ContextOverflowError
    → Publishes Session.Event.Error({sessionID, error})
    → Sets status to 'idle' (context overflow SKIPS retry logic)
    ↓
Plugin event forwarding → oh-my-opencode 'event' hook
    ↓
anthropic-context-window-limit-recovery hook
    → Parses raw error text with regex to extract currentTokens/maxTokens
    → Phase 1: Truncate largest tool outputs
    → Phase 2: Summarize with SAME model
    → Retry with SAME model
    ↗ NEVER switches model
```

### What Already Exists

| Component | Location | Status |
|-----------|----------|--------|
| Overflow detection (12+ providers) | `opencode/src/provider/error.ts` | ✅ Working |
| `session.error` event with typed error | `opencode/src/session/index.ts` | ✅ Working |
| `prompt_async` API with model override | `opencode/src/server/routes/session.ts` | ✅ Working |
| Plugin SDK `client.session.prompt_async()` | `@opencode-ai/plugin` | ✅ Working |
| Token limit error parsing (regex-based) | `oh-my-opencode/src/hooks/.../parser.ts` | ✅ Working (fragile) |
| Context window monitor (70% threshold) | `oh-my-opencode/src/hooks/context-window-monitor.ts` | ✅ Working |
| Fallback chains per agent/category | `oh-my-opencode/src/shared/model-requirements.ts` | ✅ Defined (install-time only) |
| `resolveModelWithFallback()` | `oh-my-opencode/src/shared/model-resolver.ts` | ✅ Working (install-time only) |
| Truncate + summarize recovery | `oh-my-opencode/src/hooks/.../executor.ts` | ✅ Working (same model only) |

### Three Identified Gaps

1. **Structured Overflow Data** — opencode passes raw error text; oh-my-opencode must regex-parse it per provider
2. **Runtime Model Fallback** — fallback chains exist but are only used at install-time config generation
3. **Input Window Update** — no mechanism to signal model switches to the user/TUI

---

## Proposed Architecture

### Error Flow (After Changes)

```
Provider returns "context too long"
    ↓
ProviderError.parseAPICallError()  [CHANGED]
    → Extracts currentTokens/maxTokens from regex (already done internally)
    → Returns {type: 'context_overflow', message, responseBody,
               currentTokens?, maxTokens?}        ← NEW structured fields
    ↓
MessageV2.fromError()  [CHANGED]
    → Creates ContextOverflowError({message, responseBody,
               currentTokens?, maxTokens?})        ← NEW fields passed through
    ↓
processor.ts  [CHANGED]
    → Sets assistant.error = ContextOverflowError (with structured fields)
    → Publishes Session.Event.Error({sessionID, error})
       error now includes providerID/modelID from assistant message  ← NEW
    → Sets status to 'idle'
    ↓
Plugin event forwarding → oh-my-opencode 'event' hook
    ↓
context-window-fallback hook  [NEW]
    → Reads structured {currentTokens, maxTokens, providerID, modelID}
    → Looks up agent's fallback chain from model-requirements.ts
    → Finds next model with sufficient context window
    → If found: calls client.session.prompt_async({model: fallbackModel})
    → Shows toast: "Model switched: old → new (context overflow)"
    → If no suitable fallback: falls through to existing truncate/summarize
    ↓
(Input window auto-updates via lastModel() reading new user message)
```

---

## Changes by Project

### opencode-platform Changes

#### 1. Extend ContextOverflowError Schema

**File:** `packages/opencode/src/session/message-v2.ts`

```typescript
// BEFORE
export const ContextOverflowError = NamedError.create("ContextOverflowError", {
  message: z.string(),
  responseBody: z.string().optional(),
})

// AFTER
export const ContextOverflowError = NamedError.create("ContextOverflowError", {
  message: z.string(),
  responseBody: z.string().optional(),
  currentTokens: z.number().optional(),
  maxTokens: z.number().optional(),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
})
```

#### 2. Extract Token Counts in parseAPICallError()

**File:** `packages/opencode/src/provider/error.ts`

The existing `OVERFLOW_PATTERNS` regex array already captures token counts in some patterns (e.g. `(\d[\d,]*)\s*tokens?\s*[>exceeds]+\s*(\d[\d,]*)`) but the parsed numbers are discarded.

```typescript
// In parseAPICallError(), after overflow detection:
// BEFORE: return { type: "context_overflow", message: errorMessage, responseBody }

// AFTER: extract token counts from the matched pattern
const tokenInfo = extractTokenCounts(errorMessage, responseBody)
return {
  type: "context_overflow",
  message: errorMessage,
  responseBody,
  currentTokens: tokenInfo?.currentTokens,
  maxTokens: tokenInfo?.maxTokens,
}
```

New helper function:
```typescript
function extractTokenCounts(message: string, responseBody?: string): 
  { currentTokens?: number; maxTokens?: number } | undefined {
  // Try structured responseBody first (JSON with token fields)
  // Then try regex extraction from message text
  // Patterns: "N tokens > M maximum", "prompt N tokens exceeds M", etc.
}
```

#### 3. Include providerID/modelID in Session.Event.Error for Overflow

**File:** `packages/opencode/src/session/processor.ts`

```typescript
// In the error handling block, when ContextOverflowError is detected:
// The assistant message already has providerID and modelID fields

const overflowError = MessageV2.ContextOverflowError.isInstance(error)
  ? {
      ...error.toObject(),
      providerID: this.message.providerID,  // Already available
      modelID: this.message.modelID,        // Already available
    }
  : error.toObject()

Bus.publish(Session.Event.Error, {
  sessionID,
  error: overflowError,
})
```

---

### oh-my-opencode Changes

#### 4. New Hook: context-window-fallback

**File:** `src/hooks/context-window-fallback/index.ts`

```typescript
export function createContextWindowFallbackHook(ctx: PluginContext): Hook {
  const state: FallbackState = {
    triedModels: new Map(),      // sessionID → Set<providerID/modelID>
    fallbackInProgress: new Set(), // sessionIDs with active fallback
    lastFallbackTime: new Map(),  // sessionID → timestamp (rate limiting)
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.error") return
      
      const error = event.properties.error
      if (!isContextOverflowError(error)) return
      
      const sessionID = event.properties.sessionID
      if (!sessionID) return
      if (state.fallbackInProgress.has(sessionID)) return // prevent recursion
      
      // Extract overflow info (structured fields or regex fallback)
      const overflowInfo = parseOverflowInfo(error)
      
      // Get current agent from session
      const agent = await getSessionAgent(ctx.client, sessionID)
      
      // Resolve next fallback model
      const fallback = resolveRuntimeFallback({
        currentModel: { providerID: overflowInfo.providerID, modelID: overflowInfo.modelID },
        agent,
        triedModels: state.triedModels.get(sessionID) ?? new Set(),
        currentTokens: overflowInfo.currentTokens,
      })
      
      if (!fallback) {
        // No suitable fallback — let existing truncate/summarize handle it
        return
      }
      
      // Execute fallback
      state.fallbackInProgress.add(sessionID)
      trackTriedModel(state, sessionID, overflowInfo.providerID, overflowInfo.modelID)
      
      try {
        await ctx.client.tui.showToast({
          body: {
            message: `Context overflow — switching to ${fallback.providerID}/${fallback.modelID}`,
            type: "info",
          }
        })
        
        await ctx.client.session.prompt_async(sessionID, {
          body: {
            model: { providerID: fallback.providerID, modelID: fallback.modelID },
            auto: true,
          }
        })
      } finally {
        state.fallbackInProgress.delete(sessionID)
      }
    }
  }
}
```

#### 5. Extend model-resolver.ts with Runtime Fallback

**File:** `src/shared/model-resolver.ts`

```typescript
export interface RuntimeFallbackInput {
  currentModel: { providerID: string; modelID: string }
  agent: string
  triedModels: Set<string>          // "providerID/modelID" strings already attempted
  currentTokens?: number            // How many tokens the overflow message needed
}

export interface RuntimeFallbackResult {
  providerID: string
  modelID: string
  contextWindow: number
  source: "agent-fallback" | "category-fallback"
}

export function resolveRuntimeFallback(input: RuntimeFallbackInput): RuntimeFallbackResult | undefined {
  // 1. Get fallback chain for this agent
  const chain = AGENT_MODEL_REQUIREMENTS[input.agent]?.fallbackChain
    ?? CATEGORY_MODEL_REQUIREMENTS["unspecified-high"]?.fallbackChain
    ?? []

  // 2. Find current model's position in chain
  const currentKey = `${input.currentModel.providerID}/${input.currentModel.modelID}`

  // 3. Iterate chain AFTER current model, skip already-tried models
  for (const entry of chain) {
    const entryKey = `${entry.providers[0]}/${entry.model}`
    if (entryKey === currentKey) continue
    if (input.triedModels.has(entryKey)) continue

    // 4. Check if model has larger context window (if token count known)
    const contextWindow = MODEL_CONTEXT_WINDOWS[entryKey]
    if (input.currentTokens && contextWindow && contextWindow <= input.currentTokens) continue

    // 5. Check provider availability at runtime
    if (isProviderAvailable(entry.providers[0])) {
      return {
        providerID: entry.providers[0],
        modelID: entry.model,
        contextWindow: contextWindow ?? Infinity,
        source: "agent-fallback",
      }
    }
  }

  return undefined // No suitable fallback found
}
```

#### 6. Model Context Window Registry

**File:** `src/shared/model-context-windows.ts` (NEW)

```typescript
/** Known context window sizes (in tokens) for runtime fallback decisions */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "anthropic/claude-sonnet-4-20250514": 200_000,
  "anthropic/claude-opus-4-20250514": 200_000,
  "anthropic/claude-haiku-3.5": 200_000,
  
  // OpenAI  
  "openai/gpt-5.2": 1_000_000,
  "openai/gpt-5.2-codex": 1_000_000,
  "openai/gpt-5-nano": 128_000,
  
  // Google
  "google/gemini-3-pro": 2_000_000,
  "google/gemini-3-flash": 1_000_000,
  
  // Others
  "xai/grok-code": 131_072,
  "zhipu/glm-4.7": 128_000,
}
```

#### 7. Loop Protection

```typescript
// In FallbackState:
const MAX_FALLBACK_ATTEMPTS = 3
const FALLBACK_COOLDOWN_MS = 5_000

// Before attempting fallback:
const tried = state.triedModels.get(sessionID) ?? new Set()
if (tried.size >= MAX_FALLBACK_ATTEMPTS) {
  // Max attempts reached — let truncate/summarize handle it
  return
}

const lastTime = state.lastFallbackTime.get(sessionID) ?? 0
if (Date.now() - lastTime < FALLBACK_COOLDOWN_MS) {
  // Too soon — rate limit
  return
}
```

#### 8. Session Cleanup

```typescript
// On session.deleted or session.idle (successful):
state.triedModels.delete(sessionID)
state.fallbackInProgress.delete(sessionID)
state.lastFallbackTime.delete(sessionID)
```

---

## Integration Order with Existing Hooks

The new `context-window-fallback` hook must fire **BEFORE** the existing `anthropic-context-window-limit-recovery` hook. This establishes a priority chain:

1. **context-window-fallback** — Try switching to a larger model (fast, no data loss)
2. **anthropic-context-window-limit-recovery** — If no fallback available, truncate + summarize (slow, lossy)

Hook registration order in `src/index.ts` controls priority.

---

## How Input Window Auto-Updates

No explicit work needed. opencode's `lastModel(sessionID)` function scans messages backwards:

```typescript
async function lastModel(sessionID: string) {
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}
```

When `prompt_async` is called with a new model, it creates a new user message with that model. The next input will auto-resolve to the new model. The TUI reflects this change.

---

## Risk Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| Infinite fallback loop | High | Max 3 attempts per session, tried-models tracking, cooldown timer |
| Fallback model also overflows | Medium | Each overflow adds model to tried set; chain terminates at last entry |
| Provider API key not configured | Medium | `isProviderAvailable()` checks at runtime before attempting |
| User explicitly chose a model | Low | User-set models have highest priority in resolution; fallback respects this |
| Token count parsing fails | Medium | Fallback works without token counts (just tries next model in chain) |
| Race condition with existing recovery | Medium | `fallbackInProgress` flag prevents both hooks from acting simultaneously |
| Stale context window data | Low | Registry is static; update via config or model registry API in future |

---

## Files Changed

### opencode-platform
| File | Change |
|------|--------|
| `packages/opencode/src/session/message-v2.ts` | Extend ContextOverflowError schema |
| `packages/opencode/src/provider/error.ts` | Extract + pass token counts |
| `packages/opencode/src/session/processor.ts` | Include providerID/modelID in error event |

### oh-my-opencode
| File | Change |
|------|--------|
| `src/hooks/context-window-fallback/index.ts` | NEW — runtime fallback hook |
| `src/hooks/context-window-fallback/types.ts` | NEW — types + constants |
| `src/shared/model-resolver.ts` | Add `resolveRuntimeFallback()` |
| `src/shared/model-context-windows.ts` | NEW — context window size registry |
| `src/index.ts` | Register new hook (before existing recovery hook) |

---

## Testing Strategy

1. **Unit tests** for `extractTokenCounts()` — verify parsing across all 12+ provider error formats
2. **Unit tests** for `resolveRuntimeFallback()` — verify chain traversal, tried-model skipping, context window filtering
3. **Unit tests** for loop protection — max attempts, cooldown, cleanup
4. **Integration test** — simulate `session.error` event with ContextOverflowError, verify `prompt_async` called with correct fallback model
5. **Edge cases** — all models tried (graceful degradation), provider unavailable, missing token counts
