import { isSensitiveKey, sanitizeError } from "./sanitize.js";

/** Long string args are truncated in the audit log to keep lines bounded. */
const MAX_AUDIT_ARG_LENGTH = 200;

function sanitizeArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isSensitiveKey(key)) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > MAX_AUDIT_ARG_LENGTH) {
      sanitized[key] = `${value.substring(0, MAX_AUDIT_ARG_LENGTH)}...[truncated]`;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/** Secrets shorter than this are not scrubbed: they would shred the log. */
const MIN_SECRET_LENGTH = 4;

export class AuditLogger {
  // Exact secret values (password, live tokens). Every string that reaches
  // stderr has these removed, whatever the caller passed in.
  private secrets = new Set<string>();

  /** Register a value that must never appear in an audit line. */
  addSecret(value: string | undefined): void {
    if (value && value.length >= MIN_SECRET_LENGTH) this.secrets.add(value);
  }

  private scrub(value: unknown): unknown {
    if (typeof value === "string") {
      let out = sanitizeError(value);
      for (const s of this.secrets) out = out.split(s).join("[REDACTED]");
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => this.scrub(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.scrub(v)])
      );
    }
    return value;
  }

  private write(entry: Record<string, unknown>): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...(this.scrub(entry) as Record<string, unknown>),
    });
    process.stderr.write(`[audit] ${line}\n`);
  }

  logToolCall(
    tool: string,
    args: Record<string, unknown>,
    result: "success" | "error",
    durationMs: number,
    errorMessage?: string
  ): void {
    this.write({
      event: "tool_call",
      tool,
      args: sanitizeArgs(args),
      result,
      duration_ms: durationMs,
      ...(errorMessage && { error: errorMessage }),
    });
  }

  logAuth(event: string, success: boolean, details?: string): void {
    this.write({
      event: "auth",
      action: event,
      success,
      ...(details && { details }),
    });
  }

  logSecurity(event: string, details: string): void {
    this.write({
      event: "security",
      action: event,
      details,
    });
  }

  logStartup(version: string, serverUrl: string): void {
    this.write({
      event: "startup",
      version,
      server: serverUrl,
    });
  }

  logShutdown(signal: string): void {
    this.write({
      event: "shutdown",
      signal,
    });
  }
}

export const audit = new AuditLogger();
