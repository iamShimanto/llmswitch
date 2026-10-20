import { describe, expect, it } from "vitest";
import { classifyError, classifyStatus, isRetryable, UpstreamError } from "../src/router/errors.js";

describe("classifyStatus", () => {
  it("429 → rate_limited (retryable)", () => {
    expect(classifyStatus(429)).toBe("rate_limited");
    expect(isRetryable("rate_limited")).toBe(true);
  });
  it("5xx → server_error (retryable)", () => {
    expect(classifyStatus(500)).toBe("server_error");
    expect(classifyStatus(503)).toBe("server_error");
    expect(isRetryable("server_error")).toBe(true);
  });
  it("401/403 → auth_error (NOT retryable)", () => {
    expect(classifyStatus(401)).toBe("auth_error");
    expect(isRetryable("auth_error")).toBe(false);
  });
  it("400/404 → bad_request (NOT retryable)", () => {
    expect(classifyStatus(400)).toBe("bad_request");
    expect(isRetryable("bad_request")).toBe(false);
  });
});

describe("classifyError", () => {
  it("passes through UpstreamError kind", () => {
    expect(classifyError(new UpstreamError("auth_error", 401, "bad key"))).toBe("auth_error");
  });
  it("detects timeouts from message", () => {
    expect(classifyError(new Error("request timed out"))).toBe("timeout");
    expect(isRetryable("timeout")).toBe(true);
  });
});
