#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { TechnitiumClient } from "./client.js";
import { getAllTools } from "./tools/index.js";
import { audit } from "./audit.js";
import { RateLimiter } from "./rate-limit.js";
import { sanitizeError, sanitizeResponse, maskUrl } from "./sanitize.js";
import { ValidationError } from "./errors.js";
import type { ToolDefinition } from "./types.js";
import { withMetadata, deriveRateTiers, buildToolResult } from "./registry.js";

/** Single source of truth: read the version from the package manifest. */
function readVersion(): string {
  try {
    const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf-8");
    return (JSON.parse(pkg).version as string) ?? "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readVersion();

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new TechnitiumClient(config);
  const allTools = getAllTools(client);

  // Filter out write tools in readonly mode
  const tools = config.readonly
    ? allTools.filter((t) => t.readonly)
    : allTools;

  if (config.readonly) {
    audit.logSecurity(
      "readonly_mode",
      `Exposing ${tools.length} of ${allTools.length} tools (write tools hidden)`
    );
  }

  const toolMap = new Map(tools.map((t) => [t.definition.name, t]));

  // Derive rate-limit tiers from the registered tools so they can never drift
  // out of sync with a renamed or newly added write tool.
  const rateLimiter = new RateLimiter(deriveRateTiers(tools));

  // Serve each tool with strict schemas (no unknown params) and derived safety
  // annotations so hosts get a machine-readable read-only/destructive signal.
  const servedTools: ToolDefinition[] = tools.map((t) => withMetadata(t));

  const server = new Server(
    { name: "technitium-mcp", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: servedTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);

    if (!tool) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
        ],
        isError: true,
      };
    }

    // Rate limit check
    const rateCheck = rateLimiter.check(name);
    if (!rateCheck.allowed) {
      audit.logSecurity("rate_limited", `Tool ${name} rate limited`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Rate limited",
              retryAfterMs: rateCheck.retryAfterMs,
            }),
          },
        ],
        isError: true,
      };
    }

    const startTime = Date.now();

    try {
      const rawResult = await tool.handler((args || {}) as Record<string, unknown>);

      // A confirm=false preview didn't perform the action, so refund its
      // rate-limit slot — previews shouldn't exhaust the destructive budget.
      if (
        rawResult &&
        typeof rawResult === "object" &&
        (rawResult as { requiresConfirm?: unknown }).requiresConfirm === true
      ) {
        rateLimiter.refund(name);
      }

      const { text, structuredContent } = buildToolResult(
        tool,
        rawResult,
        sanitizeResponse
      );

      audit.logToolCall(
        name,
        (args || {}) as Record<string, unknown>,
        "success",
        Date.now() - startTime
      );

      return {
        content: [{ type: "text" as const, text }],
        ...(structuredContent && { structuredContent }),
      };
    } catch (error) {
      // Validation errors are author-constructed and safe to surface verbatim;
      // everything else is sanitized in case it carries upstream internals.
      const isValidation = error instanceof ValidationError;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = isValidation ? rawMessage : sanitizeError(rawMessage);

      audit.logToolCall(
        name,
        (args || {}) as Record<string, unknown>,
        "error",
        Date.now() - startTime,
        message
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: message,
              ...(isValidation && { type: "validation" }),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    audit.logShutdown(signal);
    // Force-exit if a graceful close hangs, so we never wedge on shutdown.
    setTimeout(() => process.exit(1), 5000).unref();
    client.clearToken();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Log crashes through the audit channel rather than dropping the transport
  // silently; sanitize first so a stack/path never reaches stderr in the clear.
  process.on("uncaughtException", (err) => {
    audit.logSecurity("uncaught_exception", sanitizeError(err.message));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    audit.logSecurity("unhandled_rejection", sanitizeError(msg));
    process.exit(1);
  });

  const transport = new StdioServerTransport();
  audit.logStartup(VERSION, maskUrl(config.url));
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  audit.logSecurity("fatal_error", sanitizeError(message));
  process.exit(1);
});
