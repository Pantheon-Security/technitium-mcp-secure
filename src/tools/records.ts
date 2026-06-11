import type { TechnitiumClient } from "../client.js";
import type { ToolEntry } from "../types.js";
import {
  validateDomain,
  validateRecordType,
  validateIp,
  validateStringLength,
} from "../validate.js";
import { UpstreamError, ValidationError } from "../errors.js";
import { sanitizeError } from "../sanitize.js";

const MAX_RECORD_VALUE_LENGTH = 4096;

// dns_list_records bounds: cap how many zones are exported, how many records
// are returned, and how many exports run at once (don't hammer the DNS server).
const MAX_LIST_ZONES = 50;
const MAX_LIST_RECORDS = 5000;
const EXPORT_CONCURRENCY = 8;

const validateText = (v: string): string =>
  validateStringLength(v, MAX_RECORD_VALUE_LENGTH, "value");

/** Run an async mapper over items with a bounded number in flight; preserves order. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

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
        if (!Number.isNaN(t)) defaultTtl = t;
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
          "List DNS records in a zone. Returns a flat, normalized record list " +
          "({name, ttl, type, value}) drawn from the zone (and any subzones of " +
          "the given name, e.g. app.example.com when zone=example.com). Pass " +
          "domain to filter to records for that exact name only. Always returns " +
          "{ zone, zones, recordCount, records } (plus domain/errors when relevant).",
        inputSchema: {
          type: "object",
          properties: {
            zone: {
              type: "string",
              description:
                "Zone domain name (e.g. example.com). Can be a parent domain to include subzones.",
            },
            domain: {
              type: "string",
              description:
                "Optional exact record name to filter to (e.g. www.example.com).",
            },
          },
          required: ["zone"],
        },
      },
      readonly: true,
      untrusted: true,
      handler: async (args) => {
        const zone = validateDomain(args.zone as string);
        const domain = args.domain
          ? validateDomain(args.domain as string)
          : undefined;

        // Find the requested zone and any of its subzones.
        const zoneList = await client.callOrThrow("/api/zones/list");
        if (!Array.isArray(zoneList.zones)) {
          throw new UpstreamError(
            "Unexpected response from /api/zones/list: missing zones array"
          );
        }
        const matched = (
          zoneList.zones as Array<{ name: string; internal: boolean }>
        )
          .filter(
            (z) => !z.internal && (z.name === zone || z.name.endsWith(`.${zone}`))
          )
          .map((z) => z.name);
        // Always attempt the requested zone itself, even if /list didn't list it.
        if (!matched.includes(zone)) matched.unshift(zone);

        // Cap the zone fan-out so a parent matching hundreds of subzones can't
        // trigger an unbounded number of exports.
        const zonesTruncated = matched.length > MAX_LIST_ZONES;
        const toExport = matched.slice(0, MAX_LIST_ZONES);

        // Export + parse each zone (bounded concurrency) into one normalized,
        // flat record list — the single tested path, order preserved.
        type ZoneResult =
          | { zone: string; records: BindRecord[] }
          | { zone: string; error: string };
        const exported = await mapBounded<string, ZoneResult>(
          toExport,
          EXPORT_CONCURRENCY,
          async (z) => {
            try {
              const bindText = await client.callRawText("/api/zones/export", { zone: z });
              return { zone: z, records: parseBind(z, bindText) };
            } catch (e) {
              return {
                zone: z,
                error: sanitizeError(e instanceof Error ? e.message : String(e)),
              };
            }
          }
        );

        const records: BindRecord[] = [];
        const zonesRead: string[] = [];
        const errors: Array<{ zone: string; error: string }> = [];
        for (const r of exported) {
          if ("error" in r) {
            errors.push({ zone: r.zone, error: r.error });
          } else {
            zonesRead.push(r.zone);
            records.push(...r.records);
          }
        }

        const filtered = domain
          ? records.filter((r) => r.name === domain)
          : records;
        const recordsTruncated = filtered.length > MAX_LIST_RECORDS;
        const result = filtered.slice(0, MAX_LIST_RECORDS);

        return {
          zone,
          ...(domain && { domain }),
          zones: zonesRead,
          recordCount: result.length,
          records: result,
          ...(errors.length > 0 && { errors }),
          ...((zonesTruncated || recordsTruncated) && {
            truncated: {
              zones: zonesTruncated,
              records: recordsTruncated,
              totalZonesMatched: matched.length,
            },
          }),
        };
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
