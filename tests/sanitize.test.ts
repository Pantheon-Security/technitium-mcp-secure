import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeError,
  sanitizeResponse,
  maskUrl,
  isSensitiveKey,
} from "../src/sanitize.js";

test("isSensitiveKey catches casing/suffix variants but not benign lookalikes", () => {
  for (const k of ["password", "APIKey", "CONNECTION_STRING", "proxyPassword", "dnsTlsCertificatePassword", "authToken"]) {
    assert.equal(isSensitiveKey(k), true, `${k} should be sensitive`);
  }
  for (const k of ["bypass", "compass", "blockingBypassList", "username", "domain"]) {
    assert.equal(isSensitiveKey(k), false, `${k} should NOT be sensitive`);
  }
});

test("sanitizeError redacts hex tokens", () => {
  const out = sanitizeError("token=0123456789abcdef0123456789abcdef failed");
  assert.match(out, /\[REDACTED_TOKEN\]/);
  assert.doesNotMatch(out, /0123456789abcdef/);
});

test("sanitizeError redacts credentials in URLs", () => {
  const out = sanitizeError("connect to https://admin:hunter2@dns.local/api");
  assert.match(out, /\[REDACTED_URL\]/);
  assert.doesNotMatch(out, /hunter2/);
});

test("sanitizeError redacts unix and windows file paths", () => {
  assert.match(sanitizeError("read /etc/technitium/token.txt"), /\[REDACTED_PATH\]/);
  assert.match(sanitizeError("read C:\\ProgramData\\token.txt"), /\[REDACTED_PATH\]/);
});

test("sanitizeError redacts stack traces", () => {
  const out = sanitizeError("boom at handler (/app/src/x.js:12:5)");
  assert.match(out, /\[STACK_TRACE\]/);
});

test("sanitizeError is idempotent", () => {
  const once = sanitizeError("token=0123456789abcdef0123456789abcdef");
  assert.equal(sanitizeError(once), once);
});

test("sanitizeResponse redacts sensitive keys at any depth", () => {
  const out = sanitizeResponse({
    ok: true,
    password: "p",
    nested: { token: "t", proxyPassword: "x", safe: "keep" },
  }) as Record<string, unknown>;
  assert.equal(out.password, "[REDACTED]");
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.token, "[REDACTED]");
  assert.equal(nested.proxyPassword, "[REDACTED]");
  assert.equal(nested.safe, "keep");
});

test("sanitizeResponse strips stackTrace entirely", () => {
  const out = sanitizeResponse({ stackTrace: "secret", ok: 1 }) as Record<string, unknown>;
  assert.ok(!("stackTrace" in out));
  assert.equal(out.ok, 1);
});

test("sanitizeResponse redacts long hex inside string values", () => {
  const out = sanitizeResponse({
    note: "key is 0123456789abcdef0123456789abcdef0123",
  }) as Record<string, unknown>;
  assert.match(out.note as string, /\[REDACTED_TOKEN\]/);
});

test("sanitizeResponse strips file paths and stack traces from value strings", () => {
  const out = sanitizeResponse({
    error: "boom at handler (/app/src/x.js:12:5) reading /etc/technitium/token.txt",
  }) as Record<string, unknown>;
  const s = out.error as string;
  assert.match(s, /\[STACK_TRACE\]/);
  assert.match(s, /\[REDACTED_PATH\]/);
  assert.doesNotMatch(s, /\/etc\/technitium/);
});

test("sanitizeResponse handles arrays and null", () => {
  assert.deepEqual(sanitizeResponse([{ token: "x" }, null]), [
    { token: "[REDACTED]" },
    null,
  ]);
});

test("maskUrl keeps protocol/host/port, drops path", () => {
  assert.equal(maskUrl("https://dns.local:5380/api/x"), "https://dns.local:5380");
  assert.equal(maskUrl("not a url"), "[INVALID_URL]");
});
