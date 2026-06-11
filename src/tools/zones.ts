import type { TechnitiumClient } from "../client.js";
import type { ToolEntry } from "../types.js";
import {
  validateDomain,
  validateZoneType,
  validateReverseProxyAcl,
  validateForwarders,
} from "../validate.js";
import { capList, confirmGuard } from "../registry.js";

/** Per-key validators for free-text zone-option values that reach the API. */
const ZONE_OPTION_VALIDATORS: Record<string, (v: string) => string> = {
  // both are comma-separated network/host lists forwarded to /zones/options/set
  zoneTransferAllowedNetworks: validateReverseProxyAcl,
  notifyNameServers: validateForwarders,
};

// Settable zone-option keys, once, feeding both the schema and the allowlist.
const ZONE_OPTIONS_PROPERTIES = {
  zone: { type: "string", description: "Zone domain name" },
  disabled: { type: "boolean", description: "Set zone disabled state" },
  zoneTransferAllowedNetworks: {
    type: "string",
    description: "Comma-separated list of IP/CIDR allowed for zone transfers",
  },
  notifyNameServers: {
    type: "string",
    description: "Comma-separated list of name server IPs to notify on changes",
  },
} as const;

export function zoneTools(client: TechnitiumClient): ToolEntry[] {
  return [
    {
      definition: {
        name: "dns_list_zones",
        description:
          "List all DNS zones configured on the server. Returns zone name, type (Primary/Secondary/Stub/Forwarder), status, and record count.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      readonly: true,
      handler: async () => {
        const data = await client.callOrThrow("/api/zones/list");
        return capList(data, "zones");
      },
    },
    {
      definition: {
        name: "dns_create_zone",
        description:
          "Create a new DNS zone. Use 'Primary' for hosting records locally, 'Forwarder' for conditional forwarding.",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description: "Zone domain name (e.g. example.com)",
            },
            type: {
              type: "string",
              enum: ["Primary", "Secondary", "Stub", "Forwarder"],
              description: "Zone type (default: Primary)",
            },
          },
          required: ["zone"],
        },
      },
      readonly: false,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const type = args.type
          ? validateZoneType(args.type as string)
          : "Primary";
        const data = await client.callOrThrow("/api/zones/create", {
          zone,
          type,
        });
        return data;
      },
    },
    {
      definition: {
        name: "dns_delete_zone",
        description:
          "Delete a DNS zone and all its records. Requires confirm=true to execute.",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description: "Zone domain name to delete",
            },
            confirm: {
              type: "boolean",
              description:
                "Must be true to confirm deletion. Without this, returns a warning instead of deleting.",
            },
          },
          required: ["zone"],
        },
      },
      readonly: false,
      idempotent: true,
      destructive: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const guard = confirmGuard(
          args,
          `This will permanently delete zone '${zone}' and ALL its records. Set confirm=true to proceed.`
        );
        if (guard) return guard;
        const data = await client.callOrThrow("/api/zones/delete", { zone });
        return { success: true, deleted: zone, ...data };
      },
    },
    {
      definition: {
        name: "dns_zone_options",
        description:
          "Get the configuration options for a specific zone including DNSSEC, transfer, and notify settings.",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description: "Zone domain name",
            },
          },
          required: ["zone"],
        },
      },
      readonly: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const data = await client.callOrThrow("/api/zones/options/get", {
          zone,
        });
        return data;
      },
    },
    {
      definition: {
        name: "dns_enable_zone",
        description: "Enable a disabled DNS zone.",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description: "Zone domain name to enable",
            },
          },
          required: ["zone"],
        },
      },
      readonly: false,
      idempotent: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const data = await client.callOrThrow("/api/zones/enable", { zone });
        return { success: true, enabled: zone, ...data };
      },
    },
    {
      definition: {
        name: "dns_disable_zone",
        description:
          "Disable a DNS zone. The zone will stop responding to queries but its records are preserved.",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description: "Zone domain name to disable",
            },
          },
          required: ["zone"],
        },
      },
      readonly: false,
      idempotent: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const data = await client.callOrThrow("/api/zones/disable", { zone });
        return { success: true, disabled: zone, ...data };
      },
    },
    {
      definition: {
        name: "dns_set_zone_options",
        description:
          "Set configuration options for a zone. Pass the zone name plus any option key/value pairs to update (e.g. notify settings, zone transfer ACLs).",
        inputSchema: {
          type: "object",
          properties: ZONE_OPTIONS_PROPERTIES,
          required: ["zone"],
        },
      },
      readonly: false,
      idempotent: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        // Allowlist derives from the schema keys (minus the zone selector).
        const params: Record<string, string> = { zone };
        for (const [key, value] of Object.entries(args)) {
          if (key !== "zone" && key in ZONE_OPTIONS_PROPERTIES && value !== undefined) {
            const raw = String(value);
            const validate = ZONE_OPTION_VALIDATORS[key];
            params[key] = validate ? validate(raw) : raw;
          }
        }
        const data = await client.callOrThrow(
          "/api/zones/options/set",
          params
        );
        return { success: true, zone, ...data };
      },
    },
    {
      definition: {
        name: "dns_export_zone",
        description:
          "Export a DNS zone file in standard BIND format. Returns the zone file as text.",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description: "Zone domain name to export",
            },
          },
          required: ["zone"],
        },
      },
      readonly: true,
      untrusted: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const text = await client.callRawText("/api/zones/export", { zone });
        return { zone, zoneFile: text };
      },
    },
  ];
}
