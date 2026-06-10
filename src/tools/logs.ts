import { TechnitiumClient } from "../client.js";
import { ToolEntry } from "../types.js";
import {
  validateDomain,
  validateIp,
  validateRecordType,
  validateStringLength,
} from "../validate.js";
import { ValidationError } from "../errors.js";

const DEFAULT_ENTRIES_PER_PAGE = 25;
const MAX_ENTRIES_PER_PAGE = 100;

export function logTools(client: TechnitiumClient): ToolEntry[] {
  return [
    {
      definition: {
        name: "dns_query_logs",
        description:
          "Query DNS server logs with optional filters. Returns recent DNS queries and their responses. Requires the Query Logs app to be installed.",
        inputSchema: {
          type: "object",
          properties: {
            pageNumber: {
              type: "number",
              minimum: 1,
              description: "Page number (default: 1)",
            },
            entriesPerPage: {
              type: "number",
              minimum: 1,
              maximum: MAX_ENTRIES_PER_PAGE,
              description: "Entries per page (default: 25, max: 100)",
            },
            domain: {
              type: "string",
              description: "Filter by domain name (exact match, e.g. github.com)",
            },
            clientIp: {
              type: "string",
              description: "Filter by client IP address",
            },
            queryType: {
              type: "string",
              enum: [
                "A",
                "AAAA",
                "CNAME",
                "MX",
                "NS",
                "PTR",
                "SOA",
                "TXT",
                "ANY",
              ],
              description: "Filter by DNS query type",
            },
            responseCode: {
              type: "string",
              enum: [
                "NoError",
                "ServerFailure",
                "NxDomain",
                "Refused",
                "FormatError",
              ],
              description: "Filter by response code",
            },
          },
        },
      },
      readonly: true,
      untrusted: true,
      handler: async (args) => {
        const params: Record<string, string> = {
          name: "Query Logs (Sqlite)",
          classPath: "QueryLogsSqlite.App",
          pageNumber: String(Math.max(Number(args.pageNumber) || 1, 1)),
          entriesPerPage: String(
            Math.min(
              Number(args.entriesPerPage) || DEFAULT_ENTRIES_PER_PAGE,
              MAX_ENTRIES_PER_PAGE
            )
          ),
        };

        if (args.domain) {
          // API uses 'qname' (exact match on the DNS question name column)
          params.qname = validateStringLength(
            args.domain as string,
            253,
            "domain"
          );
        }
        if (args.clientIp) {
          params.clientIpAddress = validateIp(args.clientIp as string);
        }
        if (args.queryType) {
          params.type = validateRecordType(args.queryType as string);
        }
        if (args.responseCode) {
          const valid = new Set([
            "NoError",
            "ServerFailure",
            "NxDomain",
            "Refused",
            "FormatError",
          ]);
          const code = args.responseCode as string;
          if (!valid.has(code)) {
            throw new ValidationError(`Invalid response code: ${code}`);
          }
          params.rcode = code;
        }

        const data = await client.callOrThrow("/api/logs/query", params);
        return data;
      },
    },
  ];
}
