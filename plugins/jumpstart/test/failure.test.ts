import { describe, expect, it } from "vitest";
import { failureFromEvents, isNetworkFailure, needsRestart, type ErrorEvent } from "../src/failure";

const providerError = (detail: string, extra: Record<string, unknown> = {}, createdAt = 1_000): ErrorEvent => ({
  type: "provider/error",
  createdAt,
  data: { message: "Provider error", detail, ...extra },
});

const systemError = (detail: string, createdAt = 1_000): ErrorEvent => ({
  type: "system/error",
  createdAt,
  data: { code: "thread_command_failed", message: "Command turn.submit failed", detail },
});

describe("isNetworkFailure", () => {
  it.each([
    "Connection error.",
    "Request timed out.",
    "JSON-RPC request timed out: turn/start",
    "pi did not answer prompt in time",
    "pi did not answer get_state in time",
    "Host is not connected",
    "read ECONNRESET",
    "connect ECONNREFUSED 127.0.0.1:443",
    "getaddrinfo ENOTFOUND api.openai.com",
    "getaddrinfo EAI_AGAIN api.anthropic.com",
    "socket hang up",
    "TypeError: fetch failed",
    "Stream disconnected before completion",
    "OpenAI API error (503): Service Unavailable",
    "502 Bad Gateway",
    "Anthropic API error (529): overloaded_error",
    "[internal] Starting the tunnel agent failed (timed out after 63 s, no output)",
  ])("%s is a network failure", (text) => {
    expect(isNetworkFailure(text, null)).toBe(true);
  });

  it.each([
    "Ambiguous Pi model \"gpt-6-astra\": served by openai, openai-1m. Prefix it with the provider you want.",
    "OpenAI API error (400): {\"message\":\"Invalid schema for function 'k8s_triage'\"}",
    "404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"Model not found\"}}",
    "meta API error (402): {\"code\":\"billing_not_configured\"}",
    "_wtp loom/lane-13-6 failed (exit 1):\nerror: no free slots. Run 'wtp status' or 'wtp free' to release a slot",
    "pi exited (code 0, signal null)",
    "Zone //areas/core/network-policy is not defined in tree pool-2",
    "You exceeded your current quota (429)",
  ])("%s is not a network failure", (text) => {
    expect(isNetworkFailure(text, null)).toBe(false);
  });

  it("trusts the provider's own category over the text", () => {
    const info = (category: string, httpStatusCode: number | null = null) => ({ category, httpStatusCode, providerCode: null });
    expect(isNetworkFailure("boom", info("connection-failed"))).toBe(true);
    expect(isNetworkFailure("boom", info("stream-disconnected"))).toBe(true);
    expect(isNetworkFailure("boom", info("overloaded"))).toBe(true);
    expect(isNetworkFailure("boom", info("unknown", 503))).toBe(true);
    expect(isNetworkFailure("Request timed out.", info("context-window-exceeded"))).toBe(false);
    expect(isNetworkFailure("Request timed out.", info("rate-limit", 429))).toBe(false);
    expect(isNetworkFailure("Connection error.", info("unknown"))).toBe(true);
  });
});

describe("needsRestart", () => {
  it.each([
    "pi did not answer prompt in time",
    "pi did not answer get_state in time",
    "JSON-RPC request timed out: turn/start",
    "pi exited (code null, signal SIGKILL)",
    "Pi exited before input was consumed",
    "No active Pi session",
  ])("%s needs the agent started again", (text) => {
    expect(needsRestart(text)).toBe(true);
  });

  it.each(["Connection error.", "Request timed out.", "Host is not connected", "OpenAI API error (503): Service Unavailable"])(
    "%s leaves the agent running",
    (text) => {
      expect(needsRestart(text)).toBe(false);
    },
  );
});

describe("failureFromEvents", () => {
  it("reads the newest final error, skipping attempts the provider was still retrying", () => {
    const events = [
      providerError("Request timed out.", { willRetry: true }, 3_000),
      providerError("Connection error.", {}, 2_000),
      providerError("Connection error.", { willRetry: true }, 1_000),
    ];
    expect(failureFromEvents(events)).toEqual({ reason: "Connection error.", failedAt: 2_000, network: true, restart: false });
  });

  it("falls back to the newest error when every one was a retry", () => {
    expect(failureFromEvents([providerError("Connection error.", { willRetry: true }, 5_000)])).toEqual({
      reason: "Connection error.",
      failedAt: 5_000,
      network: true,
      restart: false,
    });
  });

  it("uses a system error's detail, and its message when it has none", () => {
    expect(failureFromEvents([systemError("Host is not connected")]).reason).toBe("Host is not connected");
    expect(
      failureFromEvents([{ type: "system/error", createdAt: 1, data: { message: "Provisioning thread failed" } }]).reason,
    ).toBe("Provisioning thread failed");
  });

  it("collapses whitespace and caps a long reason", () => {
    const failure = failureFromEvents([systemError(`fatal:\n\n  ${"x".repeat(1_000)}`)]);
    expect(failure.reason?.startsWith("fatal: xxx")).toBe(true);
    expect(failure.reason?.length).toBeLessThanOrEqual(400);
    expect(failure.network).toBe(false);
  });

  it("ignores errors from before the thread's latest turn", () => {
    const events = [
      { type: "client/turn/requested", createdAt: 2_000, data: {} },
      providerError("Connection error.", {}, 1_000),
    ];
    expect(failureFromEvents(events)).toEqual({ reason: null, failedAt: null, network: false, restart: false });
  });

  it("marks a failure whose agent stopped answering for a restart", () => {
    expect(failureFromEvents([systemError("JSON-RPC request timed out: turn/start")])).toMatchObject({ network: true, restart: true });
  });

  it("reports no reason when the log has no error", () => {
    expect(failureFromEvents([])).toEqual({ reason: null, failedAt: null, network: false, restart: false });
  });
});
