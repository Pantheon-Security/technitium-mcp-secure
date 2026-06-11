import { test } from "node:test";
import assert from "node:assert/strict";
import { withMetadata, deriveRateTiers, capList, MAX_LIST_ITEMS } from "../src/registry.js";

test("capList truncates an over-limit array and flags it; passes small ones through", () => {
  const big = { zones: Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => i), other: 1 };
  const capped = capList(big, "zones") as {
    zones: number[];
    other: number;
    truncated?: { field: string; returned: number; total: number };
  };
  assert.equal(capped.zones.length, MAX_LIST_ITEMS);
  assert.equal(capped.other, 1, "other fields preserved");
  assert.equal(capped.truncated?.total, MAX_LIST_ITEMS + 5);

  const small = { zones: [1, 2, 3] };
  assert.equal(capList(small, "zones"), small, "under-limit returned unchanged");
  assert.equal(capList({ apps: "notarray" }, "apps").truncated, undefined);
});
import { getAllTools } from "../src/tools/index.js";
import type { TechnitiumClient } from "../src/client.js";
import type { ToolEntry } from "../src/types.js";

const tools = getAllTools({} as TechnitiumClient);
const byName = new Map(tools.map((t) => [t.definition.name, t]));

test("withMetadata sets additionalProperties:false on the served schema", () => {
  for (const t of tools) {
    const def = withMetadata(t);
    assert.equal(
      def.inputSchema.additionalProperties,
      false,
      `${t.definition.name} must forbid additional properties`
    );
  }
});

test("withMetadata derives read-only / destructive / openWorld annotations", () => {
  const read = withMetadata(byName.get("dns_list_zones")!);
  assert.equal(read.annotations?.readOnlyHint, true);
  assert.equal(read.annotations?.destructiveHint, false);

  const del = withMetadata(byName.get("dns_delete_zone")!);
  assert.equal(del.annotations?.readOnlyHint, false);
  assert.equal(del.annotations?.destructiveHint, true);

  const ext = withMetadata(byName.get("dns_resolve")!);
  assert.equal(ext.annotations?.openWorldHint, true);
});

test("withMetadata derives idempotentHint for set-state writes only", () => {
  // delete is idempotent (same end state); create/add are not.
  assert.equal(withMetadata(byName.get("dns_delete_zone")!).annotations?.idempotentHint, true);
  assert.equal(withMetadata(byName.get("dns_set_settings")!).annotations?.idempotentHint, true);
  assert.equal(withMetadata(byName.get("dns_create_zone")!).annotations?.idempotentHint, false);
  assert.equal(withMetadata(byName.get("dns_add_record")!).annotations?.idempotentHint, false);
});

test("deriveRateTiers gives destructive tools the strict tier and reads no tier", () => {
  const tiers = deriveRateTiers(tools);
  assert.equal(tiers.get("dns_delete_zone"), "destructive");
  assert.equal(tiers.get("dns_add_record"), "mutate");
  assert.equal(tiers.has("dns_list_zones"), false, "read-only tools take no per-tool tier");
});

test("deriveRateTiers covers a renamed destructive tool automatically (no drift)", () => {
  // Simulate adding a new destructive tool: the tier is derived from its flag,
  // not from any hardcoded name list, so it can't be forgotten.
  const fresh: ToolEntry = {
    definition: { name: "dns_new_destroyer", description: "x", inputSchema: { type: "object", properties: {} } },
    handler: async () => "{}",
    readonly: false,
    destructive: true,
  };
  const tiers = deriveRateTiers([...tools, fresh]);
  assert.equal(tiers.get("dns_new_destroyer"), "destructive");
});
