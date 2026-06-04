export interface TechnitiumResponse {
  status: "ok" | "error" | "invalid-token";
  response?: Record<string, unknown>;
  errorMessage?: string;
  stackTrace?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
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
}
