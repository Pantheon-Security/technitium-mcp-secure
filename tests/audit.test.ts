import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditLogger } from "../src/audit.js";

/** Capture one stderr line emitted by an AuditLogger call. */
function captureStderr(fn: () => void): Record<string, unknown> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as { write: unknown }).write = (chunk: string) => {
    captured += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  const json = captured.replace(/^\[audit\]\s*/, "").trim();
  return JSON.parse(json) as Record<string, unknown>;
}

test("logToolCall redacts sensitive args", () => {
  const log = new AuditLogger();
  const entry = captureStderr(() =>
    log.logToolCall("dns_set_settings", { password: "secret", host: "x" }, "success", 12)
  );
  const args = entry.args as Record<string, unknown>;
  assert.equal(args.password, "[REDACTED]");
  assert.equal(args.host, "x");
  assert.equal(entry.event, "tool_call");
  assert.equal(entry.result, "success");
});

test("logToolCall truncates very long string args", () => {
  const log = new AuditLogger();
  const entry = captureStderr(() =>
    log.logToolCall("dns_add_record", { value: "z".repeat(500) }, "success", 1)
  );
  const args = entry.args as Record<string, unknown>;
  assert.match(args.value as string, /\.\.\.\[truncated\]$/);
  assert.ok((args.value as string).length < 500);
});

test("every entry carries a timestamp", () => {
  const log = new AuditLogger();
  const entry = captureStderr(() => log.logSecurity("readonly_mode", "x"));
  assert.match(entry.timestamp as string, /^\d{4}-\d{2}-\d{2}T/);
});
