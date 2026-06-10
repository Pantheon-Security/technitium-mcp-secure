import { TechnitiumClient } from "../client.js";
import { ToolEntry } from "../types.js";
import { validateDomain } from "../validate.js";

export function cacheTools(client: TechnitiumClient): ToolEntry[] {
  return [
    {
      definition: {
        name: "dns_flush_cache",
        description:
          "Flush the entire DNS cache. Forces all subsequent queries to be resolved fresh from upstream. Requires confirm=true to execute.",
        inputSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description:
                "Must be true to confirm cache flush. Without this, returns a warning instead.",
            },
          },
        },
      },
      readonly: false,
      idempotent: true,
      destructive: true,
      handler: async (args) => {
        if (args.confirm !== true) {
          return {
              warning:
                "This will flush the entire DNS cache. All subsequent queries will be resolved fresh from upstream, which may temporarily increase latency. Set confirm=true to proceed.",
            };
        }
        const data = await client.callOrThrow("/api/cache/flush");
        return { success: true, message: "Cache flushed", ...data };
      },
    },
    {
      definition: {
        name: "dns_list_cache",
        description:
          "List zones in the DNS cache. Returns a hierarchical tree — call with no domain to see top-level zones, then pass a domain (e.g. 'com') to drill into cached subdomains.",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description:
                "Optional parent domain to list children of (e.g. 'com' to see cached .com domains). Omit to see top-level zones.",
            },
          },
        },
      },
      readonly: true,
      untrusted: true,
      handler: async (args) => {
        const params: Record<string, string> = {};
        if (args.domain) params.domain = validateDomain(args.domain as string);
        const data = await client.callOrThrow("/api/cache/list", params);
        return data;
      },
    },
    {
      definition: {
        name: "dns_delete_cached",
        description:
          "Delete a specific domain from the DNS cache. Unlike flush, this only removes the specified domain.",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to delete from cache (e.g. example.com)",
            },
          },
          required: ["domain"],
        },
      },
      readonly: false,
      idempotent: true,
      destructive: true,
      rateTier: "mutate",
      handler: async (args) => {
        const domain = validateDomain(args.domain as string);
        const data = await client.callOrThrow("/api/cache/delete", { domain });
        return { success: true, deleted: domain, ...data };
      },
    },
  ];
}
