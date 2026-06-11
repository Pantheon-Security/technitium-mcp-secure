import { isSensitiveKey } from "./sanitize.js";

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

export class AuditLogger {
  private write(entry: Record<string, unknown>): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
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
