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

export interface ToolHandler {
  (args: Record<string, unknown>): Promise<string>;
}

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
   * Abuse rate-limit tier. Defaults: readonly tools are unlimited (global cap
   * only), destructive tools get the strict tier, other writes the mutate tier.
   * Set explicitly to override the derived default.
   */
  rateTier?: "destructive" | "mutate";
}
