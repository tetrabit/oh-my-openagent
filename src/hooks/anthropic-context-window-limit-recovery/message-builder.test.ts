import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as shared from "../../shared"
import * as sharedLogger from "../../shared/logger"
import * as opencodeStorageDetection from "../../shared/opencode-storage-detection"
import * as sessionRecoveryStorage from "../session-recovery/storage"
import * as emptyTextStorage from "../session-recovery/storage/empty-text"
import * as textPartInjector from "../session-recovery/storage/text-part-injector"
import { PLACEHOLDER_TEXT, sanitizeEmptyMessagesBeforeSummarize } from "./message-builder"

describe("sanitizeEmptyMessagesBeforeSummarize", () => {
  let normalizeSDKResponseSpy: ReturnType<typeof spyOn>
  let loggerSpy: ReturnType<typeof spyOn>
  let sqliteBackendSpy: ReturnType<typeof spyOn>
  let findEmptyMessagesSpy: ReturnType<typeof spyOn>
  let findMessagesWithEmptyTextPartsSpy: ReturnType<typeof spyOn>
  let replaceEmptyTextPartsSpy: ReturnType<typeof spyOn>
  let injectTextPartSpy: ReturnType<typeof spyOn>
  let replaceEmptyTextPartsAsyncSpy: ReturnType<typeof spyOn>
  let injectTextPartAsyncSpy: ReturnType<typeof spyOn>
  let findMessagesWithEmptyTextPartsFromSDKSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    normalizeSDKResponseSpy = spyOn(
      shared,
      "normalizeSDKResponse",
    ).mockImplementation((response: { data?: unknown[] }) => response.data ?? [])
    loggerSpy = spyOn(sharedLogger, "log").mockImplementation(() => {})
    sqliteBackendSpy = spyOn(opencodeStorageDetection, "isSqliteBackend").mockReturnValue(true)
    findEmptyMessagesSpy = spyOn(sessionRecoveryStorage, "findEmptyMessages").mockReturnValue([])
    findMessagesWithEmptyTextPartsSpy = spyOn(
      sessionRecoveryStorage,
      "findMessagesWithEmptyTextParts",
    ).mockReturnValue([])
    replaceEmptyTextPartsSpy = spyOn(
      sessionRecoveryStorage,
      "replaceEmptyTextParts",
    ).mockReturnValue(false)
    injectTextPartSpy = spyOn(sessionRecoveryStorage, "injectTextPart").mockReturnValue(false)
    replaceEmptyTextPartsAsyncSpy = spyOn(
      emptyTextStorage,
      "replaceEmptyTextPartsAsync",
    ).mockResolvedValue(false)
    injectTextPartAsyncSpy = spyOn(
      textPartInjector,
      "injectTextPartAsync",
    ).mockResolvedValue(false)
    findMessagesWithEmptyTextPartsFromSDKSpy = spyOn(
      emptyTextStorage,
      "findMessagesWithEmptyTextPartsFromSDK",
    ).mockResolvedValue([])
  })

  afterEach(() => {
    normalizeSDKResponseSpy?.mockRestore()
    loggerSpy?.mockRestore()
    sqliteBackendSpy?.mockRestore()
    findEmptyMessagesSpy?.mockRestore()
    findMessagesWithEmptyTextPartsSpy?.mockRestore()
    replaceEmptyTextPartsSpy?.mockRestore()
    injectTextPartSpy?.mockRestore()
    replaceEmptyTextPartsAsyncSpy?.mockRestore()
    injectTextPartAsyncSpy?.mockRestore()
    findMessagesWithEmptyTextPartsFromSDKSpy?.mockRestore()
  })

  test("#given sqlite message with tool content and empty text part #when sanitizing #then it fixes the mixed-content message", async () => {
    const client = {
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { id: "msg-1" },
              parts: [
                { type: "tool_result", text: "done" },
                { type: "text", text: "" },
              ],
            },
          ],
        })),
      },
    } as never
    findMessagesWithEmptyTextPartsFromSDKSpy.mockResolvedValue(["msg-1"])
    replaceEmptyTextPartsAsyncSpy.mockResolvedValue(true)

    const fixedCount = await sanitizeEmptyMessagesBeforeSummarize("ses-1", client)

    expect(fixedCount).toBe(1)
    expect(replaceEmptyTextPartsAsyncSpy).toHaveBeenCalledWith(client, "ses-1", "msg-1", PLACEHOLDER_TEXT)
    expect(injectTextPartAsyncSpy).not.toHaveBeenCalled()
  })

  test("#given sqlite message with mixed content and failed replacement #when sanitizing #then it injects the placeholder text part", async () => {
    const client = {
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { id: "msg-2" },
              parts: [
                { type: "tool_use", text: "call" },
                { type: "text", text: "" },
              ],
            },
          ],
        })),
      },
    } as never
    findMessagesWithEmptyTextPartsFromSDKSpy.mockResolvedValue(["msg-2"])
    injectTextPartAsyncSpy.mockResolvedValue(true)

    const fixedCount = await sanitizeEmptyMessagesBeforeSummarize("ses-2", client)

    expect(fixedCount).toBe(1)
    expect(injectTextPartAsyncSpy).toHaveBeenCalledWith(client, "ses-2", "msg-2", PLACEHOLDER_TEXT)
  })
})
