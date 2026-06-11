import { test } from "node:test";
import assert from "node:assert/strict";
import { recordTools } from "../src/tools/records.js";
import { dashboardTools } from "../src/tools/dashboard.js";
import { withMetadata } from "../src/registry.js";
import type { TechnitiumClient } from "../src/client.js";

/** Stub a client: /api/zones/list returns `zones`, export returns BIND text per zone. */
function listClient(zones: string[], bindByZone: Record<string, string>) {
  return {
    callOrThrow: async (endpoint: string) => {
      if (endpoint.includes("/zones/list")) {
        return { zones: zones.map((name) => ({ name, internal: false })) };
      }
      return {};
    },
    callRawText: async (_endpoint: string, params?: Record<string, string>) => {
      const z = params?.zone ?? "";
      if (bindByZone[z] === undefined) throw new Error(`no export for ${z}`);
      return bindByZone[z];
    },
  } as unknown as TechnitiumClient;
}

function listRecords(client: TechnitiumClient, args: Record<string, unknown>) {
  const t = recordTools(client).find((x) => x.definition.name === "dns_list_records")!;
  return t.handler(args) as Promise<{
    zone: string;
    domain?: string;
    zones: string[];
    recordCount: number;
    records: Array<{ name: string; ttl: number; type: string; value: string }>;
    errors?: Array<{ zone: string; error: string }>;
  }>;
}

const ENVELOPE = ["zone", "zones", "recordCount", "records"];

test("single zone returns the unified envelope with a flat record list", async () => {
  const c = listClient(["example.com"], {
    "example.com": "www 300 IN A 1.2.3.4\n@ 300 IN A 5.6.7.8\n",
  });
  const out = await listRecords(c, { zone: "example.com" });
  for (const k of ENVELOPE) assert.ok(k in out, `missing ${k}`);
  assert.deepEqual(out.zones, ["example.com"]);
  assert.equal(out.recordCount, 2);
  assert.equal(out.records[0].name, "www.example.com");
});

test("multi-zone (parent name) returns the SAME envelope shape, flattened", async () => {
  const c = listClient(["example.com", "app.example.com"], {
    "example.com": "@ 300 IN A 1.1.1.1\n",
    "app.example.com": "@ 300 IN A 2.2.2.2\n",
  });
  const out = await listRecords(c, { zone: "example.com" });
  for (const k of ENVELOPE) assert.ok(k in out, `missing ${k}`);
  assert.equal(out.zones.length, 2);
  assert.equal(out.recordCount, 2);
});

test("domain filter returns the SAME envelope, records limited to the exact name", async () => {
  const c = listClient(["example.com"], {
    "example.com": "www 300 IN A 1.2.3.4\nmail 300 IN A 5.6.7.8\n",
  });
  const out = await listRecords(c, { zone: "example.com", domain: "www.example.com" });
  for (const k of ENVELOPE) assert.ok(k in out, `missing ${k}`);
  assert.equal(out.domain, "www.example.com");
  assert.equal(out.recordCount, 1);
  assert.equal(out.records[0].name, "www.example.com");
});

test("a failing zone export is captured in errors, not thrown", async () => {
  const c = listClient(["example.com", "broken.example.com"], {
    "example.com": "@ 300 IN A 1.1.1.1\n",
    // no export for broken.example.com -> stub throws
  });
  const out = await listRecords(c, { zone: "example.com" });
  assert.equal(out.zones.includes("broken.example.com"), false);
  assert.ok(out.errors && out.errors.some((e) => e.zone === "broken.example.com"));
});

test("caps the zone fan-out and flags truncation", async () => {
  // 60 subzones of example.com, each with one record.
  const zones = ["example.com"];
  const bind: Record<string, string> = { "example.com": "@ 300 IN A 1.1.1.1\n" };
  for (let i = 0; i < 60; i++) {
    const z = `z${i}.example.com`;
    zones.push(z);
    bind[z] = `@ 300 IN A 10.0.0.${i % 255}\n`;
  }
  const out = await listRecords(listClient(zones, bind), { zone: "example.com" });
  // MAX_LIST_ZONES is 50 — no more than 50 zones read.
  assert.ok(out.zones.length <= 50, `read ${out.zones.length} zones, expected <=50`);
  const trunc = (out as unknown as { truncated?: { zones: boolean; totalZonesMatched: number } }).truncated;
  assert.ok(trunc?.zones, "should flag zone truncation");
  assert.equal(trunc?.totalZonesMatched, 61);
});

test("bounded parallel export still returns every record, order preserved", async () => {
  const zones = ["example.com", "a.example.com", "b.example.com"];
  const out = await listRecords(
    listClient(zones, {
      "example.com": "@ 300 IN A 1.1.1.1\n",
      "a.example.com": "@ 300 IN A 2.2.2.2\n",
      "b.example.com": "@ 300 IN A 3.3.3.3\n",
    }),
    { zone: "example.com" }
  );
  assert.equal(out.recordCount, 3);
  assert.deepEqual(
    out.records.map((r) => r.name),
    ["example.com", "a.example.com", "b.example.com"]
  );
});

test("dns_health_check is served with an outputSchema; dns_list_records is not (untrusted)", () => {
  const dash = dashboardTools({} as TechnitiumClient);
  const health = dash.find((t) => t.definition.name === "dns_health_check")!;
  assert.ok(withMetadata(health).outputSchema, "trusted stable tool should declare outputSchema");

  const rec = recordTools({} as TechnitiumClient).find(
    (t) => t.definition.name === "dns_list_records"
  )!;
  assert.equal(
    withMetadata(rec).outputSchema,
    undefined,
    "untrusted tool must not declare outputSchema (would force unfenced structuredContent)"
  );
});
