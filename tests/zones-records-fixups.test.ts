import { test } from "node:test";
import assert from "node:assert/strict";
import { zoneTools } from "../src/tools/zones.js";
import { recordTools } from "../src/tools/records.js";
import type { TechnitiumClient } from "../src/client.js";

function zone(args: Record<string, unknown>) {
  let captured: Record<string, string> | undefined;
  const fake = {
    callOrThrow: async (_e: string, params?: Record<string, string>) => ((captured = params), {}),
  } as unknown as TechnitiumClient;
  const t = zoneTools(fake).find((x) => x.definition.name === "dns_set_zone_options")!;
  return t.handler(args).then(() => captured!);
}

function record(name: string, args: Record<string, unknown>) {
  let captured: Record<string, string> | undefined;
  const fake = {
    callOrThrow: async (_e: string, params?: Record<string, string>) => ((captured = params), {}),
  } as unknown as TechnitiumClient;
  const t = recordTools(fake).find((x) => x.definition.name === name)!;
  return { run: () => t.handler(args).then(() => captured!), tool: t };
}

// CR-009: dns_set_zone_options validates network/host list values
test("dns_set_zone_options validates zoneTransferAllowedNetworks", async () => {
  const params = await zone({ zone: "example.com", zoneTransferAllowedNetworks: "10.0.0.0/8, 192.168.1.5" });
  assert.equal(params.zoneTransferAllowedNetworks, "10.0.0.0/8, 192.168.1.5");
});

test("dns_set_zone_options rejects an injected/junk transfer ACL", async () => {
  await assert.rejects(
    () => zone({ zone: "example.com", zoneTransferAllowedNetworks: "10.0.0.0/8, ; rm -rf /" }),
    /Invalid/
  );
});

// CR-010: ttl=0 / priority=0 are forwarded, not dropped
test("dns_add_record forwards ttl=0 (not dropped by truthiness)", async () => {
  const params = await record("dns_add_record", {
    zone: "example.com",
    domain: "a.example.com",
    type: "A",
    value: "1.2.3.4",
    ttl: 0,
  }).run();
  assert.equal(params.ttl, "0");
});

test("dns_add_record forwards MX priority=0", async () => {
  const params = await record("dns_add_record", {
    zone: "example.com",
    domain: "example.com",
    type: "MX",
    value: "mail.example.com",
    priority: 0,
  }).run();
  assert.equal(params.preference, "0");
});

// CR-011: dns_add_record no longer advertises types it cannot add
test("dns_add_record enum drops SOA/SRV/CAA", () => {
  const { tool } = record("dns_add_record", {});
  const enumVals = (tool.definition.inputSchema.properties.type as { enum: string[] }).enum;
  for (const t of ["SOA", "SRV", "CAA"]) {
    assert.ok(!enumVals.includes(t), `${t} must not be advertised by dns_add_record`);
  }
});

test("dns_add_record rejects an unsupported type at runtime", async () => {
  await assert.rejects(
    () =>
      record("dns_add_record", {
        zone: "example.com",
        domain: "example.com",
        type: "SOA",
        value: "x",
      }).run(),
    /not supported/
  );
});
