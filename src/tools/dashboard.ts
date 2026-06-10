import { TechnitiumClient } from "../client.js";
import { ToolEntry } from "../types.js";
import { validatePeriod } from "../validate.js";

/** Cap each "top N" list so a LastYear query can't return a huge payload. */
const TOP_N = 20;

export function dashboardTools(client: TechnitiumClient): ToolEntry[] {
  return [
    {
      definition: {
        name: "dns_get_stats",
        description:
          "Get DNS query statistics for a time period. Returns total queries, cached, blocked, failure counts, plus top clients, top domains, and top blocked domains.",
        inputSchema: {
          type: "object",
          properties: {
            period: {
              type: "string",
              enum: [
                "LastHour",
                "LastDay",
                "LastWeek",
                "LastMonth",
                "LastYear",
              ],
              description: "Time period for stats (default: LastDay)",
            },
          },
        },
      },
      readonly: true,
      untrusted: true,
      handler: async (args) => {
        const period = args.period
          ? validatePeriod(args.period as string)
          : "LastDay";
        const data = await client.callOrThrow("/api/dashboard/stats/get", {
          type: period,
        });
        const cap = (arr: unknown): unknown[] =>
          Array.isArray(arr) ? arr.slice(0, TOP_N) : [];

        return JSON.stringify(
          {
            stats: (data.stats as Record<string, unknown>) ?? {},
            topClients: cap(data.topClients),
            topDomains: cap(data.topDomains),
            topBlockedDomains: cap(data.topBlockedDomains),
          },
          null,
          2
        );
      },
    },
    {
      definition: {
        name: "dns_health_check",
        description:
          "Quick health check of the DNS server. Returns version, uptime, forwarder config, blocking status, and last hour failure rate.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      readonly: true,
      handler: async () => {
        // allSettled so one failing dependency degrades the report rather than
        // collapsing the whole health check.
        const [settingsR, statsR] = await Promise.allSettled([
          client.callOrThrow("/api/settings/get"),
          client.callOrThrow("/api/dashboard/stats/get", {
            type: "LastHour",
          }),
        ]);

        const settings =
          settingsR.status === "fulfilled"
            ? settingsR.value
            : ({} as Record<string, unknown>);
        const s =
          statsR.status === "fulfilled"
            ? ((statsR.value.stats as Record<string, number>) ?? {})
            : {};

        const degraded: string[] = [];
        if (settingsR.status === "rejected") degraded.push("settings");
        if (statsR.status === "rejected") degraded.push("stats");

        const totalQueries = s.totalQueries || 0;
        const failures = s.totalServerFailure || 0;
        const failureRate =
          totalQueries > 0
            ? ((failures / totalQueries) * 100).toFixed(1)
            : "0.0";

        return JSON.stringify(
          {
            status: degraded.length === 0 ? "ok" : "degraded",
            ...(degraded.length > 0 && { unavailable: degraded }),
            version: settings.version,
            uptimestamp: settings.uptimestamp,
            dnsServerDomain: settings.dnsServerDomain,
            forwarders: settings.forwarders,
            forwarderProtocol: settings.forwarderProtocol,
            enableBlocking: settings.enableBlocking,
            lastHour: {
              totalQueries,
              serverFailures: failures,
              failureRate: `${failureRate}%`,
              blocked: s.totalBlocked || 0,
              cached: s.totalCached || 0,
            },
          },
          null,
          2
        );
      },
    },
    {
      definition: {
        name: "dns_check_update",
        description:
          "Check if a newer version of Technitium DNS Server is available.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      readonly: true,
      untrusted: true,
      handler: async () => {
        const data = await client.callOrThrow("/api/user/checkForUpdate");
        return JSON.stringify(data, null, 2);
      },
    },
  ];
}
