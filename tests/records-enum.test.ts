import { test } from "node:test";
import assert from "node:assert/strict";
import { recordTools } from "../src/tools/records.js";
import type { TechnitiumClient } from "../src/client.js";

/** Capture the params the handler forwards to the Technitium API. */
function captureParams(toolName: string, args: Record<string, unknown>) {
  let captured: Record<string, string> | undefined;
  const fake = {
    callOrThrow: async (_endpoint: string, params?: Record<string, string>) => {
      captured = params;
      return {};
    },
  } as unknown as TechnitiumClient;
  const tool = recordTools(fake).find((t) => t.definition.name === toolName)!;
  return tool.handler(args).then(() => captured!);
}

test("dns_update_record maps NS values to nameServer params", async () => {
  const params = await captureParams("dns_update_record", {
    zone: "example.com",
    domain: "example.com",
    type: "NS",
    value: "ns1.example.com",
    newValue: "ns2.example.com",
  });
  assert.equal(params.nameServer, "ns1.example.com");
  assert.equal(params.newNameServer, "ns2.example.com");
});

test("dns_update_record maps PTR values to ptrName params", async () => {
  const params = await captureParams("dns_update_record", {
    zone: "0.0.10.in-addr.arpa",
    domain: "1.0.0.10.in-addr.arpa",
    type: "PTR",
    value: "host-a.example.com",
    newValue: "host-b.example.com",
  });
  assert.equal(params.ptrName, "host-a.example.com");
  assert.equal(params.newPtrName, "host-b.example.com");
});

test("dns_delete_record maps PTR value to ptrName param", async () => {
  const params = await captureParams("dns_delete_record", {
    zone: "0.0.10.in-addr.arpa",
    domain: "1.0.0.10.in-addr.arpa",
    type: "PTR",
    value: "host-a.example.com",
    confirm: true,
  });
  assert.equal(params.ptrName, "host-a.example.com");
});

test("dns_delete_record no longer advertises SRV/CAA it cannot delete", () => {
  const tool = recordTools({} as TechnitiumClient).find(
    (t) => t.definition.name === "dns_delete_record"
  )!;
  const enumVals = (tool.definition.inputSchema.properties.type as { enum: string[] }).enum;
  assert.ok(!enumVals.includes("SRV"), "SRV must not be advertised");
  assert.ok(!enumVals.includes("CAA"), "CAA must not be advertised");
});
