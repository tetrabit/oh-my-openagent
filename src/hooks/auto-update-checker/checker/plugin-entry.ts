import * as fs from "node:fs"
import type { OpencodeConfig } from "../types"
import { PACKAGE_NAME } from "../constants"
import { getConfigPaths } from "./config-paths"
import { stripJsonComments } from "./jsonc-strip"
import { parsePluginEntry } from "./parse-plugin-entry"

export interface PluginEntryInfo {
  entry: string
  isPinned: boolean
  pinnedVersion: string | null
  configPath: string
}

export function findPluginEntry(directory: string): PluginEntryInfo | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue
      const content = fs.readFileSync(configPath, "utf-8")
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig
      const parsed = parsePluginEntry(config.plugin ?? [], PACKAGE_NAME)
      if (parsed) {
        return {
          ...parsed,
          configPath,
        }
      }
    } catch {
      continue
    }
  }

  return null
}
