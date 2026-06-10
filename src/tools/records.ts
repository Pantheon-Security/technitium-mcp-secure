import { TechnitiumClient } from "../client.js";
import { ToolEntry } from "../types.js";
import {
  validateDomain,
  validateRecordType,
  validateIp,
  validateStringLength,
} from "../validate.js";
import { UpstreamError, ValidationError } from "../errors.js";
import { sanitizeError } from "../sanitize.js";

const MAX_RECORD_VALUE_LENGTH = 4096;

const validateText = (v: string): string =>
  validateStringLength(v, MAX_RECORD_VALUE_LENGTH, "value");

/**
 * Single source of truth for how each record type maps to Technitium API
 * params and how its value is validated. Drives add/update/delete so the
 * mapping can't drift between them. The supported set is exactly the types
 * this single-value tool can express (SOA/SRV/CAA need multi-field values).
 */
interface RecordFieldSpec {
  field: string; // API param carrying the (current) value
  newField: string; // API param carrying the new value (update only)
  validate: (v: string) => string;
  priorityField?: string; // extra param fed from args.priority (add only)
}

const RECORD_FIELDS: Record<string, RecordFieldSpec> = {
  A: { field: "ipAddress", newField: "newIpAddress", validate: validateIp },
  AAAA: { field: "ipAddress", newField: "newIpAddress", validate: validateIp },
  CNAME: { field: "cname", newField: "newCname", validate: validateDomain },
  NS: { field: "nameServer", newField: "newNameServer", validate: validateDomain },
  PTR: { field: "ptrName", newField: "newPtrName", validate: validateDomain },
  MX: { field: "exchange", newField: "newExchange", validate: validateDomain, priorityField: "preference" },
  TXT: { field: "text", newField: "newText", validate: validateText },
};

function recordSpec(recType: string, tool: string): RecordFieldSpec {
  const spec = RECORD_FIELDS[recType];
  if (!spec) {
    throw new ValidationError(`Record type ${recType} is not supported by ${tool}`);
  }
  return spec;
}

type BindRecord = { name: string; ttl: number; type: string; value: string };

const DNS_CLASSES = new Set(["IN", "CS", "CH", "HS"]);

/**
 * Coalesce a BIND export into logical records: strip comments, and join
 * parenthesised multi-line records (e.g. SOA) into a single line. Returns each
 * logical line plus whether its owner field was blank (leading whitespace),
 * which in BIND means "same owner as the previous record".
 */
function coalesceBindLines(bindText: string): Array<{ text: string; ownerBlank: boolean }> {
  const out: Array<{ text: string; ownerBlank: boolean }> = [];
  let buffer = "";
  let depth = 0;
  let ownerBlank = false;

  for (const raw of bindText.split("\n")) {
    // Naive comment strip — a ';' starts a comment (does not handle ';' inside
    // quoted TXT data, a rare case Technitium exports don't produce).
    const noComment = raw.replace(/;.*$/, "");
    if (depth === 0) {
      if (!noComment.trim()) continue;
      ownerBlank = /^\s/.test(raw);
    }
    buffer += (buffer ? " " : "") + noComment.trim();
    depth += (noComment.match(/\(/g) || []).length;
    depth -= (noComment.match(/\)/g) || []).length;
    if (depth <= 0) {
      const text = buffer.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
      if (text) out.push({ text, ownerBlank });
      buffer = "";
      depth = 0;
    }
  }
  return out;
}

/**
 * Parse a BIND-format zone export into structured records. Handles $TTL/$ORIGIN
 * directives, optional ttl/class columns in either order, $TTL-inherited
 * records (no explicit ttl), parenthesised multi-line records, and blank-owner
 * continuation lines.
 */
export function parseBind(zone: string, bindText: string): BindRecord[] {
  const records: BindRecord[] = [];
  let origin = zone.endsWith(".") ? zone.slice(0, -1) : zone;
  let defaultTtl: number | undefined;
  let lastOwner: string | undefined;

  for (const { text, ownerBlank } of coalesceBindLines(bindText)) {
    if (text.startsWith("$")) {
      const [directive, value] = text.split(/\s+/);
      if (directive === "$TTL") {
        const t = parseInt(value, 10);
        if (!isNaN(t)) defaultTtl = t;
      } else if (directive === "$ORIGIN" && value) {
        origin = value.replace(/\.$/, "");
      }
      continue;
    }

    const tokens = text.split(/\s+/);

    // Owner: blank (continuation) reuses the previous record's owner.
    let owner: string;
    if (ownerBlank && lastOwner !== undefined) {
      owner = lastOwner;
    } else {
      owner = tokens.shift() ?? "";
      lastOwner = owner;
    }

    // ttl and class are both optional and may appear in either order.
    let ttl = defaultTtl;
    if (tokens.length && DNS_CLASSES.has(tokens[0].toUpperCase())) tokens.shift();
    if (tokens.length && /^\d+$/.test(tokens[0])) ttl = parseInt(tokens.shift() as string, 10);
    if (tokens.length && DNS_CLASSES.has(tokens[0].toUpperCase())) tokens.shift();

    // Need a type, rdata, and a known ttl (explicit or inherited from $TTL).
    if (tokens.length < 2 || ttl === undefined) continue;
    const type = tokens.shift() as string;
    const value = tokens.join(" ");

    // Owner ending in "." is absolute; otherwise it is relative to the origin.
    const name =
      owner === "@"
        ? origin
        : owner.endsWith(".")
          ? owner.slice(0, -1)
          : `${owner}.${origin}`;

    records.push({ name, ttl, type, value });
  }

  return records;
}

export function recordTools(client: TechnitiumClient): ToolEntry[] {
  return [
    {
      definition: {
        name: "dns_list_records",
        description:
          "List DNS records in a zone. Optionally filter by a specific domain name within the zone. " +
          "When no domain is specified, returns all records across all zones matching the zone name " +
          "(including subzones like app.example.com when zone=example.com). " +
          "When domain is specified, returns records for that exact domain only.",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description:
                "Zone domain name (e.g. example.com). Can be a parent domain to list all subzones.",
            },
            domain: {
              type: "string",
              description:
                "Optional specific domain to filter (e.g. www.example.com). Defaults to the zone name if omitted.",
            },
          },
          required: ["zone"],
        },
      },
      readonly: true,
      untrusted: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);

        if (args.domain) {
          // Specific domain requested — query that domain directly
          const domain = validateDomain(args.domain as string);
          const data = await client.callOrThrow("/api/zones/records/get", {
            zone,
            domain,
          });
          return data;
        }

        // No domain specified — find all zones that match or are subzones of the requested name
        const zoneList = await client.callOrThrow("/api/zones/list");
        if (!Array.isArray(zoneList.zones)) {
          throw new UpstreamError(
            "Unexpected response from /api/zones/list: missing zones array"
          );
        }
        const allZones = (
          zoneList.zones as Array<{ name: string; internal: boolean }>
        ).filter(
          (z) =>
            !z.internal &&
            (z.name === zone || z.name.endsWith("." + zone))
        );

        if (allZones.length === 0) {
          // No matching zones — fall back to direct query (will surface API error if zone missing)
          const data = await client.callOrThrow("/api/zones/records/get", {
            zone,
            domain: zone,
          });
          return data;
        }

        if (allZones.length === 1 && allZones[0].name === zone) {
          // Exact single zone — export to get ALL records (apex + subdomains)
          const bindText = await client.callRawText("/api/zones/export", {
            zone,
          });
          return { zone, records: parseBind(zone, bindText) };
        }

        // Multiple zones or parent-level query — export each and combine
        const results: unknown[] = [];
        for (const z of allZones) {
          try {
            const bindText = await client.callRawText("/api/zones/export", {
              zone: z.name,
            });
            results.push({ zone: z.name, records: parseBind(z.name, bindText) });
          } catch (e) {
            results.push({
              zone: z.name,
              error: sanitizeError(e instanceof Error ? e.message : String(e)),
            });
          }
        }
        return { totalZones: results.length, zones: results };
      },
    },
    {
      definition: {
        name: "dns_add_record",
        description:
          "Add a DNS record to a zone. Creates the zone automatically if it doesn't exist for Primary type.",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description: "Zone domain name",
            },
            domain: {
              type: "string",
              description: "Full domain name for the record",
            },
            type: {
              type: "string",
              enum: ["A", "AAAA", "CNAME", "MX", "NS", "PTR", "TXT"],
              description: "Record type",
            },
            value: {
              type: "string",
              description:
                "Record value (IP for A/AAAA, hostname for CNAME/MX/NS, text for TXT)",
            },
            ttl: {
              type: "number",
              minimum: 0,
              maximum: 2147483647,
              description: "TTL in seconds (default: 3600)",
            },
            overwrite: {
              type: "boolean",
              description:
                "Overwrite existing records of the same type (default: false)",
            },
            priority: {
              type: "number",
              minimum: 0,
              maximum: 65535,
              description: "Priority for MX records",
            },
          },
          required: ["zone", "domain", "type", "value"],
        },
      },
      readonly: false,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const domain = validateDomain(args.domain as string);
        const recType = validateRecordType(args.type as string);
        const value = args.value as string;

        const params: Record<string, string> = {
          zone,
          domain,
          type: recType,
          overwrite: args.overwrite ? "true" : "false",
        };

        if (args.ttl !== undefined) params.ttl = String(args.ttl);

        const spec = recordSpec(recType, "dns_add_record");
        params[spec.field] = spec.validate(value);
        if (spec.priorityField && args.priority !== undefined) {
          params[spec.priorityField] = String(args.priority);
        }

        const data = await client.callOrThrow(
          "/api/zones/records/add",
          params
        );
        return data;
      },
    },
    {
      definition: {
        name: "dns_update_record",
        description: "Update an existing DNS record.",
        inputSchema: {
          type: "object",
          properties: {
            zone: { type: "string", description: "Zone domain name" },
            domain: { type: "string", description: "Current domain name" },
            type: {
              type: "string",
              enum: ["A", "AAAA", "CNAME", "MX", "NS", "PTR", "TXT"],
              description: "Record type",
            },
            value: { type: "string", description: "Current record value" },
            newValue: { type: "string", description: "New record value" },
            newDomain: {
              type: "string",
              description: "New domain name (to rename)",
            },
            ttl: {
              type: "number",
              minimum: 0,
              maximum: 2147483647,
              description: "New TTL in seconds",
            },
          },
          required: ["zone", "domain", "type", "value", "newValue"],
        },
      },
      readonly: false,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const domain = validateDomain(args.domain as string);
        const recType = validateRecordType(args.type as string);

        const params: Record<string, string> = {
          zone,
          domain,
          type: recType,
        };

        if (args.newDomain)
          params.newDomain = validateDomain(args.newDomain as string);
        if (args.ttl !== undefined) params.ttl = String(args.ttl);

        const value = args.value as string;
        const newValue = args.newValue as string;

        const spec = recordSpec(recType, "dns_update_record");
        params[spec.field] = spec.validate(value);
        params[spec.newField] = spec.validate(newValue);

        const data = await client.callOrThrow(
          "/api/zones/records/update",
          params
        );
        return data;
      },
    },
    {
      definition: {
        name: "dns_delete_record",
        description:
          "Delete a specific DNS record from a zone. Requires confirm=true to execute.",
        inputSchema: {
          type: "object",
          properties: {
            zone: { type: "string", description: "Zone domain name" },
            domain: {
              type: "string",
              description: "Domain name of the record",
            },
            type: {
              type: "string",
              enum: ["A", "AAAA", "CNAME", "MX", "NS", "PTR", "TXT"],
              description: "Record type",
            },
            value: {
              type: "string",
              description: "Record value to delete (IP for A/AAAA, etc)",
            },
            confirm: {
              type: "boolean",
              description:
                "Must be true to confirm deletion. Without this, returns a warning instead of deleting.",
            },
          },
          required: ["zone", "domain", "type", "value"],
        },
      },
      readonly: false,
      idempotent: true,
      destructive: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const domain = validateDomain(args.domain as string);
        const recType = validateRecordType(args.type as string);
        const rawValue = args.value as string;

        // Validate the value for its record type up front so it is safe both to
        // echo in the confirmation message and to forward to the API.
        const params: Record<string, string> = { zone, domain, type: recType };
        const spec = recordSpec(recType, "dns_delete_record");
        const value = spec.validate(rawValue);
        params[spec.field] = value;

        if (args.confirm !== true) {
          return {
              warning: `This will delete the ${recType} record for '${domain}' (value: ${value}). Set confirm=true to proceed.`,
            };
        }

        const data = await client.callOrThrow(
          "/api/zones/records/delete",
          params
        );
        return {
            success: true,
            deleted: `${recType} ${domain} -> ${value}`,
            ...data,
          };
      },
    },
  ];
}
