import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { McpOAuthProvider } from "../../features/mcp-oauth/provider"
import { login } from "./login"

const mockLogin = mock(() => Promise.resolve({ accessToken: "test-token", expiresAt: 1710000000 }))
let loginSpy: ReturnType<typeof spyOn>

describe("login command", () => {
  beforeEach(() => {
    mockLogin.mockClear()
    loginSpy = spyOn(McpOAuthProvider.prototype, "login").mockImplementation(() => mockLogin())
  })

  afterEach(() => {
    loginSpy.mockRestore()
  })

  it("returns error code when server-url is not provided", async () => {
    // given
    const serverName = "test-server"
    const options = {}

    // when
    const exitCode = await login(serverName, options)

    // then
    expect(exitCode).toBe(1)
  })

  it("returns success code when login succeeds", async () => {
    // given
    const serverName = "test-server"
    const options = {
      serverUrl: "https://oauth.example.com",
    }

    // when
    const exitCode = await login(serverName, options)

    // then
    expect(exitCode).toBe(0)
    expect(mockLogin).toHaveBeenCalledTimes(1)
  })

  it("returns error code when login throws", async () => {
    // given
    const serverName = "test-server"
    const options = {
      serverUrl: "https://oauth.example.com",
    }
    mockLogin.mockRejectedValueOnce(new Error("Network error"))

    // when
    const exitCode = await login(serverName, options)

    // then
    expect(exitCode).toBe(1)
  })

  it("returns error code when server-url is missing", async () => {
    // given
    const serverName = "test-server"
    const options = {
      clientId: "test-client-id",
    }

    // when
    const exitCode = await login(serverName, options)

    // then
    expect(exitCode).toBe(1)
  })
})
