import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardTools } from "../src/tools/dashboard.js";
import type { TechnitiumClient } from "../src/client.js";

/** Build a dashboard tool map over a stubbed client. */
function tools(callOrThrow: (endpoint: string, params?: Record<string, string>) => Promise<Record<string, unknown>>) {
  const fake = { callOrThrow } as unknown as TechnitiumClient;
  return new Map(dashboardTools(fake).map((t) => [t.definition.name, t]));
}

test("dns_get_stats caps each top-N list at 20 entries", async () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ name: `d${i}`, hits: i }));
  const map = tools(async () => ({
    stats: { totalQueries: 1 },
    topClients: big,
    topDomains: big,
    topBlockedDomains: big,
  }));
  const out = (await map.get("dns_get_stats")!.handler({})) as Record<string, any>;
  assert.equal(out.topDomains.length, 20);
  assert.equal(out.topClients.length, 20);
  assert.equal(out.topBlockedDomains.length, 20);
});

test("dns_get_stats tolerates missing top-N arrays", async () => {
  const map = tools(async () => ({ stats: { totalQueries: 0 } }));
  const out = (await map.get("dns_get_stats")!.handler({})) as Record<string, any>;
  assert.deepEqual(out.topDomains, []);
  assert.deepEqual(out.topClients, []);
});

test("dns_health_check degrades instead of throwing when stats is down", async () => {
  const map = tools(async (endpoint) => {
    if (endpoint.includes("/dashboard/stats/get")) throw new Error("stats unavailable");
    return { version: "13.0", enableBlocking: true };
  });
  const out = (await map.get("dns_health_check")!.handler({})) as Record<string, any>;
  assert.equal(out.status, "degraded");
  assert.deepEqual(out.unavailable, ["stats"]);
  assert.equal(out.version, "13.0");
});

test("dns_health_check reports ok when both dependencies succeed", async () => {
  const map = tools(async (endpoint) =>
    endpoint.includes("stats")
      ? { stats: { totalQueries: 100, totalServerFailure: 5 } }
      : { version: "13.0", enableBlocking: true }
  );
  const out = (await map.get("dns_health_check")!.handler({})) as Record<string, any>;
  assert.equal(out.status, "ok");
  assert.equal(out.lastHour.failureRate, "5.0%");
});
