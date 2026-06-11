export interface TechnitiumResponse {
  status: "ok" | "error" | "invalid-token";
  response?: Record<string, unknown>;
  errorMessage?: string;
  stackTrace?: string;
}

/** Machine-readable safety hints (subset of the MCP ToolAnnotations spec). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: ToolAnnotations;
}

// Handlers return their result as a value (object, or a raw string for text
// payloads like a BIND export). The dispatcher owns sanitization and JSON
// serialization — handlers must not stringify.
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  readonly: boolean;
  /**
   * True when the tool's output contains third-party-controlled text
   * (resolved rdata, client query names, blocklist imports, store metadata).
   * Such responses are wrapped in an untrusted-data fence before being
   * returned to the model, so injected instructions are treated as data.
   */
  untrusted?: boolean;
  /** Irreversible delete/flush/uninstall — sets destructiveHint. */
  destructive?: boolean;
  /** Contacts hosts beyond the configured Technitium server — sets openWorldHint. */
  openWorld?: boolean;
  /**
   * Repeating the call with the same args leaves the same end state (set-state
   * writes, deletes, flushes) — sets idempotentHint. Defaults to false.
   */
  idempotent?: boolean;
  /**
   * Abuse rate-limit tier. Defaults: readonly tools are unlimited (global cap
   * only), destructive tools get the strict tier, other writes the mutate tier.
   * Set explicitly to override the derived default.
   */
  rateTier?: "destructive" | "mutate";
}
