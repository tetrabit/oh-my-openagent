export interface ParsedPluginEntry {
  entry: string
  isPinned: boolean
  pinnedVersion: string | null
}

const EXACT_SEMVER_REGEX = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

export function parsePluginEntry(plugins: string[], packageName: string): ParsedPluginEntry | null {
  for (const entry of plugins) {
    if (entry === packageName) {
      return { entry, isPinned: false, pinnedVersion: null }
    }
    if (entry.startsWith(`${packageName}@`)) {
      const pinnedVersion = entry.slice(packageName.length + 1)
      const isPinned = EXACT_SEMVER_REGEX.test(pinnedVersion.trim())
      return { entry, isPinned, pinnedVersion }
    }
  }

  return null
}
