import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/rate-limit.js";

test("allows requests under the global limit", () => {
  const rl = new RateLimiter(5, 60_000);
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.check("dns_list_zones").allowed, true);
  }
});

test("blocks once the global limit is exceeded", () => {
  const rl = new RateLimiter(3, 60_000);
  rl.check("dns_list_zones");
  rl.check("dns_list_zones");
  rl.check("dns_list_zones");
  const blocked = rl.check("dns_list_zones");
  assert.equal(blocked.allowed, false);
  assert.ok((blocked.retryAfterMs ?? 0) > 0);
});

test("destructive tools get the stricter per-tool cap (5)", () => {
  // global ceiling high enough that the per-tool cap is what bites
  const rl = new RateLimiter(1000, 60_000);
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.check("dns_delete_zone").allowed, true);
  }
  assert.equal(rl.check("dns_delete_zone").allowed, false);
});

test("mutate tools get the medium per-tool cap (10)", () => {
  const rl = new RateLimiter(1000, 60_000);
  for (let i = 0; i < 10; i++) {
    assert.equal(rl.check("dns_add_record").allowed, true);
  }
  assert.equal(rl.check("dns_add_record").allowed, false);
});

test("unlisted tools are bounded only by the global limit", () => {
  const rl = new RateLimiter(1000, 60_000);
  for (let i = 0; i < 50; i++) {
    assert.equal(rl.check("dns_list_records").allowed, true);
  }
});
