import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnitiumClient } from "../src/client.js";
import type { Config } from "../src/config.js";

const baseConfig: Config = {
  url: "https://dns.local",
  token: undefined,
  user: "admin",
  password: "pw",
  readonly: false,
  allowHttp: false,
};

/** Install a fake global fetch that returns queued JSON bodies in order. */
function queueFetch(bodies: unknown[]): { calls: Array<{ url: string; body?: string }> } {
  const calls: Array<{ url: string; body?: string }> = [];
  let i = 0;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body });
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { calls };
}

test("logs in once then reuses the session token", async () => {
  const { calls } = queueFetch([
    { status: "ok", response: { token: "sess123" } },
    { status: "ok", response: { value: 1 } },
    { status: "ok", response: { value: 2 } },
  ]);
  const client = new TechnitiumClient({ ...baseConfig });
  await client.callOrThrow("/api/a");
  await client.callOrThrow("/api/b");
  const logins = calls.filter((c) => c.url.includes("/api/user/login"));
  assert.equal(logins.length, 1, "should authenticate exactly once");
});

test("re-authenticates and retries on invalid-token", async () => {
  const { calls } = queueFetch([
    { status: "ok", response: { token: "sess1" } }, // initial login
    { status: "invalid-token" }, // first call rejected
    { status: "ok", response: { token: "sess2" } }, // re-login
    { status: "ok", response: { ok: true } }, // retried call succeeds
  ]);
  const client = new TechnitiumClient({ ...baseConfig });
  const res = await client.callOrThrow("/api/thing");
  assert.deepEqual(res, { ok: true });
  const logins = calls.filter((c) => c.url.includes("/api/user/login"));
  assert.equal(logins.length, 2, "should re-login after token expiry");
});

test("callOrThrow throws on a non-ok API status", async () => {
  queueFetch([
    { status: "ok", response: { token: "sess1" } },
    { status: "error", errorMessage: "zone not found" },
  ]);
  const client = new TechnitiumClient({ ...baseConfig });
  await assert.rejects(() => client.callOrThrow("/api/x"), /zone not found/);
});

test("concurrent first calls trigger only one login (auth mutex)", async () => {
  const { calls } = queueFetch([
    { status: "ok", response: { token: "sess1" } },
    { status: "ok", response: { a: 1 } },
    { status: "ok", response: { b: 2 } },
  ]);
  const client = new TechnitiumClient({ ...baseConfig });
  await Promise.all([client.callOrThrow("/api/a"), client.callOrThrow("/api/b")]);
  const logins = calls.filter((c) => c.url.includes("/api/user/login"));
  assert.equal(logins.length, 1, "mutex should dedupe concurrent logins");
});
