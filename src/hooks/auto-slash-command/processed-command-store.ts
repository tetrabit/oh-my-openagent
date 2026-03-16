const MAX_PROCESSED_ENTRY_COUNT = 10_000
const PROCESSED_COMMAND_TTL_MS = 30_000
const PRUNE_INTERVAL_MS = 5_000

function pruneExpiredEntries(entries: Map<string, number>, now: number): void {
  for (const [commandKey, expiresAt] of entries) {
    if (expiresAt > now) {
      continue
    }

    entries.delete(commandKey)
  }
}

function trimProcessedEntries(entries: Map<string, number>): void {
  if (entries.size <= MAX_PROCESSED_ENTRY_COUNT) {
    return
  }

  const entriesToRemove = Math.floor(entries.size / 2)
  let removedEntries = 0

  for (const commandKey of entries.keys()) {
    entries.delete(commandKey)
    removedEntries += 1

    if (removedEntries >= entriesToRemove) {
      return
    }
  }
}

function removeSessionEntries(entries: Map<string, number>, sessionID: string): void {
  const sessionPrefix = `${sessionID}:`
  for (const commandKey of entries.keys()) {
    if (commandKey.startsWith(sessionPrefix)) {
      entries.delete(commandKey)
    }
  }
}

export interface ProcessedCommandStore {
  has(commandKey: string): boolean
  add(commandKey: string): void
  cleanupSession(sessionID: string): void
  clear(): void
}

export function createProcessedCommandStore(): ProcessedCommandStore {
  let entries = new Map<string, number>()
  let lastPrunedAt = 0

  function pruneIfNeeded(now: number): void {
    if (entries.size === 0) {
      lastPrunedAt = now
      return
    }

    if (now - lastPrunedAt < PRUNE_INTERVAL_MS && entries.size <= MAX_PROCESSED_ENTRY_COUNT) {
      return
    }

    pruneExpiredEntries(entries, now)
    lastPrunedAt = now
  }

  return {
    has(commandKey: string): boolean {
      const now = Date.now()
      pruneIfNeeded(now)
      return entries.has(commandKey)
    },
    add(commandKey: string): void {
      const now = Date.now()
      pruneIfNeeded(now)
      entries.delete(commandKey)
      entries.set(commandKey, now + PROCESSED_COMMAND_TTL_MS)
      trimProcessedEntries(entries)
    },
    cleanupSession(sessionID: string): void {
      removeSessionEntries(entries, sessionID)
    },
    clear(): void {
      entries.clear()
    },
  }
}
