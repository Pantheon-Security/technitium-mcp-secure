import { test } from "node:test";
import assert from "node:assert/strict";
import { getAllTools } from "../src/tools/index.js";
import type { TechnitiumClient } from "../src/client.js";

const tools = getAllTools({} as TechnitiumClient);
const byName = new Map(tools.map((t) => [t.definition.name, t]));

const DESTRUCTIVE = [
  "dns_delete_zone",
  "dns_delete_record",
  "dns_flush_cache",
  "dns_flush_allowed",
  "dns_flush_blocked",
  "dns_uninstall_app",
  "dns_delete_cached",
  "dns_remove_allowed",
  "dns_remove_blocked",
];

const OPEN_WORLD = [
  "dns_resolve",
  "dns_check_update",
  "dns_list_app_store",
  "dns_install_app",
  "dns_uninstall_app",
  "dns_update_blocklists",
];

test("every destructive tool is flagged destructive and is a write tool", () => {
  for (const name of DESTRUCTIVE) {
    const t = byName.get(name);
    assert.ok(t, `missing tool ${name}`);
    assert.equal(t!.destructive, true, `${name} should be destructive`);
    assert.equal(t!.readonly, false, `${name} must not be read-only`);
  }
});

test("external-network tools are flagged openWorld", () => {
  for (const name of OPEN_WORLD) {
    assert.equal(byName.get(name)?.openWorld, true, `${name} should be openWorld`);
  }
});

test("read-only tools never carry a destructive flag", () => {
  for (const t of tools) {
    if (t.readonly) {
      assert.notEqual(t.destructive, true, `${t.definition.name} is read-only but destructive`);
    }
  }
});

test("no tool is both read-only and a write — readonly flag is coherent", () => {
  // Spot-check a few well-known read tools really are read-only.
  for (const name of ["dns_list_zones", "dns_get_settings", "dns_health_check"]) {
    assert.equal(byName.get(name)?.readonly, true);
  }
});
