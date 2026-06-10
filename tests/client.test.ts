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

test("maps a non-ok HTTP status to an UpstreamError", async () => {
  (globalThis as { fetch: unknown }).fetch = async (url: string) => ({
    ok: url.includes("/login") ? true : false,
    status: url.includes("/login") ? 200 : 503,
    json: async () => ({ status: "ok", response: { token: "s" } }),
    text: async () => "<html>502 Bad Gateway</html>",
  });
  const client = new TechnitiumClient({ ...baseConfig });
  await assert.rejects(() => client.callOrThrow("/api/x"), /HTTP 503/);
});

test("maps a fetch timeout to an UpstreamError", async () => {
  (globalThis as { fetch: unknown }).fetch = async () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    throw e;
  };
  const client = new TechnitiumClient({ ...baseConfig, token: "pre" });
  await assert.rejects(() => client.callOrThrow("/api/x"), /timed out/);
});

test("callRawText returns raw body on success", async () => {
  const bind = "@ 3600 IN A 1.2.3.4\n";
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => bind,
    json: async () => ({}),
  });
  const client = new TechnitiumClient({ ...baseConfig, token: "pre" });
  assert.equal(await client.callRawText("/api/zones/export", { zone: "x" }), bind);
});

test("callRawText throws when the body is a JSON error envelope (not zone text)", async () => {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: "error", errorMessage: "no such zone" }),
    json: async () => ({ status: "error" }),
  });
  const client = new TechnitiumClient({ ...baseConfig, token: "pre" });
  await assert.rejects(() => client.callRawText("/api/zones/export", { zone: "x" }), /no such zone/);
});

test("callRawText re-authenticates and re-validates the retry on invalid-token", async () => {
  const calls: string[] = [];
  let i = 0;
  // Password auth (no static token) so an expired token forces a fresh login.
  const bodies = [
    JSON.stringify({ status: "ok", response: { token: "s1" } }), // initial login
    JSON.stringify({ status: "invalid-token" }), // first raw call: token expired
    JSON.stringify({ status: "ok", response: { token: "s2" } }), // re-login
    "@ 3600 IN A 9.9.9.9\n", // retried raw call succeeds
  ];
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    calls.push(String(url));
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
  const client = new TechnitiumClient({ ...baseConfig });
  const out = await client.callRawText("/api/zones/export", { zone: "x" });
  assert.match(out, /9\.9\.9\.9/);
  assert.equal(calls.filter((c) => c.includes("/api/user/login")).length, 2);
});

test("sends the token in the POST body, never the query string", async () => {
  let seenUrl = "";
  let seenBody = "";
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    seenUrl = String(url);
    seenBody = init?.body ?? "";
    return { ok: true, status: 200, text: async () => "ok\n", json: async () => ({}) };
  };
  const client = new TechnitiumClient({ ...baseConfig, token: "secrettoken" });
  await client.callRawText("/api/zones/export", { zone: "x" });
  assert.doesNotMatch(seenUrl, /token=/, "token must not appear in the URL");
  assert.match(seenBody, /token=secrettoken/, "token must travel in the body");
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
