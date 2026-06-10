// Two deliberately different hex thresholds:
//  - error strings are scrubbed aggressively (any 20+ char hex run is suspect),
//  - response bodies use a higher bar (32+) so legitimate DNS data such as
//    DNSSEC DS digests isn't clobbered. See sanitizeString below.
const ERROR_TOKEN_HEX_MIN = 20;
const RESPONSE_TOKEN_HEX_MIN = 32;

const SENSITIVE_PATTERNS: [RegExp, string][] = [
  // Hex tokens (ERROR_TOKEN_HEX_MIN+ chars)
  [new RegExp(`\\b[0-9a-f]{${ERROR_TOKEN_HEX_MIN},}\\b`, "gi"), "[REDACTED_TOKEN]"],
  // URLs with credentials
  [/https?:\/\/[^:]+:[^@]+@[^\s]+/g, "[REDACTED_URL]"],
  // File paths (Unix)
  [/\/(?:opt|home|etc|var|tmp|usr)\/[\w./-]+/g, "[REDACTED_PATH]"],
  // Windows paths
  [/[A-Z]:\\[\w\\.-]+/gi, "[REDACTED_PATH]"],
  // Stack traces
  [/at\s+\w+.*\(.*:\d+:\d+\)/g, "[STACK_TRACE]"],
  [/\s+in\s+\w+.*\\.*\.cs:line\s+\d+/g, "[STACK_TRACE]"],
];

export function sanitizeError(message: string): string {
  let sanitized = message;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

// Canonical lowercase key names. Comparison lowercases the candidate key, so
// casing variants (APIKey, CONNECTION_STRING, PrivateKey) are all caught
// without enumerating every spelling. Exact-match (not substring) so benign
// keys like "bypass" or "compass" aren't redacted. Suffix forms such as
// ...CertificatePassword / proxyPassword are caught by the endsWith check.
const SENSITIVE_KEYS = new Set([
  "password",
  "pass",
  "secret",
  "token",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "connectionstring",
  "connection_string",
]);

/** True if a key name looks like it holds a credential and must be redacted. */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    SENSITIVE_KEYS.has(lower) ||
    lower.endsWith("password") ||
    lower.endsWith("secret") ||
    lower.endsWith("token")
  );
}

export function sanitizeResponse(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === "string") return sanitizeString(data);
  if (Array.isArray(data)) return data.map(sanitizeResponse);
  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = "[REDACTED]";
      } else if (key === "stackTrace") {
        continue; // Strip stack traces entirely
      } else {
        result[key] = sanitizeResponse(value);
      }
    }
    return result;
  }
  return data;
}

function sanitizeString(value: string): string {
  // Redact long hex strings that look like tokens
  return value.replace(
    new RegExp(`\\b[0-9a-f]{${RESPONSE_TOKEN_HEX_MIN},}\\b`, "gi"),
    "[REDACTED_TOKEN]"
  );
}

export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || "?"}`;
  } catch {
    return "[INVALID_URL]";
  }
}
