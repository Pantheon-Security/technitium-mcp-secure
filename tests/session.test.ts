import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { TechnitiumClient } from "../src/client.js";

// All credential-shaped values are built at run time, so no such literal sits
// in the source. `rnd` makes a fresh value per call.
const rnd = (label: string): string => `${label}-${randomBytes(9).toString("hex")}`;

const KEYS = [
  "TECHNITIUM_URL",
  "TECHNITIUM_TOKEN",
  "TECHNITIUM_PASSWORD",
  "TECHNITIUM_TOKEN_FILE",
  "TECHNITIUM_USER",
  "TECHNITIUM_READONLY",
  "TECHNITIUM_ALLOW_HTTP",
  "TECHNITIUM_STRICT_TOKEN_PERMS",
  "TECHNITIUM_SESSION_USER",
  "TECHNITIUM_SESSION_PASS",
];

function withEnv(env: Record<string, string>, fn: () => void) {
  const saved = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const URL_ENV = { TECHNITIUM_URL: "https://dns.local" };

// ---------------------------------------------------------------- config ---

test("session mode: only the user set fails closed", () => {
  withEnv({ ...URL_ENV, TECHNITIUM_SESSION_USER: rnd("u") }, () =>
    assert.throws(() => loadConfig(), /SESSION_USER and TECHNITIUM_SESSION_PASS/)
  );
});

test("session mode: only the password set fails closed", () => {
  withEnv({ ...URL_ENV, TECHNITIUM_SESSION_PASS: rnd("p") }, () =>
    assert.throws(() => loadConfig(), /SESSION_USER and TECHNITIUM_SESSION_PASS/)
  );
});

test("session mode: an empty value counts as missing", () => {
  withEnv({ ...URL_ENV, TECHNITIUM_SESSION_USER: rnd("u"), TECHNITIUM_SESSION_PASS: "" }, () =>
    assert.throws(() => loadConfig(), /SESSION_USER and TECHNITIUM_SESSION_PASS/)
  );
  withEnv({ ...URL_ENV, TECHNITIUM_SESSION_USER: "", TECHNITIUM_SESSION_PASS: rnd("p") }, () =>
    assert.throws(() => loadConfig(), /SESSION_USER and TECHNITIUM_SESSION_PASS/)
  );
});

test("session mode: cannot be combined with any static credential", () => {
  for (const key of ["TECHNITIUM_TOKEN", "TECHNITIUM_TOKEN_FILE", "TECHNITIUM_PASSWORD"]) {
    withEnv(
      {
        ...URL_ENV,
        TECHNITIUM_SESSION_USER: rnd("u"),
        TECHNITIUM_SESSION_PASS: rnd("p"),
        [key]: rnd("x"),
      },
      () => assert.throws(() => loadConfig(), /cannot be combined/, key)
    );
  }
});

test("session mode: loads, holds no static token, clears env", () => {
  const user = rnd("u");
  const pass = rnd("p");
  withEnv(
    { ...URL_ENV, TECHNITIUM_SESSION_USER: user, TECHNITIUM_SESSION_PASS: pass },
    () => {
      const c = loadConfig();
      assert.equal(c.sessionMode, true);
      assert.equal(c.user, user);
      assert.equal(c.password, pass);
      assert.equal(c.token, undefined);
      assert.equal(process.env.TECHNITIUM_SESSION_USER, undefined);
      assert.equal(process.env.TECHNITIUM_SESSION_PASS, undefined);
    }
  );
});

test("session mode: TECHNITIUM_READONLY behaves as before", () => {
  const base = { ...URL_ENV };
  const creds = () => ({
    TECHNITIUM_SESSION_USER: rnd("u"),
    TECHNITIUM_SESSION_PASS: rnd("p"),
  });
  withEnv({ ...base, ...creds(), TECHNITIUM_READONLY: "true" }, () =>
    assert.equal(loadConfig().readonly, true)
  );
  withEnv({ ...base, ...creds() }, () => assert.equal(loadConfig().readonly, false));
});

test("session mode: error messages never contain the supplied values", () => {
  const user = rnd("u");
  const pass = rnd("p");
  withEnv(
    {
      ...URL_ENV,
      TECHNITIUM_SESSION_USER: user,
      TECHNITIUM_SESSION_PASS: pass,
      TECHNITIUM_TOKEN: rnd("t"),
    },
    () => {
      try {
        loadConfig();
        assert.fail("expected loadConfig to throw");
      } catch (err) {
        const msg = (err as Error).message;
        assert.ok(!msg.includes(user) && !msg.includes(pass));
      }
    }
  );
});

test("without session vars the static modes still load", () => {
  withEnv({ ...URL_ENV, TECHNITIUM_TOKEN: rnd("t") }, () =>
    assert.equal(loadConfig().sessionMode, undefined)
  );
});

// ---------------------------------------------------------------- client ---

interface Recorded {
  url: string;
  form: URLSearchParams;
}

/**
 * Fake Technitium. Every login mints a fresh token; every logout is recorded
 * and (optionally) revokes it. Returns the call log and the minted tokens.
 */
function fakeServer(opts: { loginStatus?: "ok" | "error"; failLogout?: boolean } = {}) {
  const calls: Recorded[] = [];
  const minted: string[] = [];
  const revoked = new Set<string>();
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    const form = new URLSearchParams(init?.body ?? "");
    calls.push({ url: String(url), form });
    const json = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (String(url).endsWith("/api/user/login")) {
      if (opts.loginStatus === "error") {
        return json({ status: "error", errorMessage: "Invalid username or password." });
      }
      const token = rnd("sess");
      minted.push(token);
      return json({ status: "ok", response: { token } });
    }
    if (String(url).endsWith("/api/user/logout")) {
      if (opts.failLogout) throw new Error("connection reset");
      revoked.add(form.get("token") ?? "");
      return json({ status: "ok" });
    }
    return json({ status: "ok", response: { value: 1 } });
  };
  return { calls, minted, revoked };
}

function sessionConfig(): Config {
  return {
    url: "https://dns.local",
    token: undefined,
    user: rnd("u"),
    password: rnd("p"),
    readonly: false,
    allowHttp: false,
    sessionMode: true,
  };
}

const logins = (calls: Recorded[]) => calls.filter((c) => c.url.endsWith("/api/user/login"));
const logouts = (calls: Recorded[]) => calls.filter((c) => c.url.endsWith("/api/user/logout"));

test("startSession logs in as the session user and calls carry that token", async () => {
  const srv = fakeServer();
  const cfg = sessionConfig();
  const client = new TechnitiumClient(cfg);
  await client.startSession();
  assert.equal(logins(srv.calls).length, 1);
  assert.equal(logins(srv.calls)[0].form.get("user"), cfg.user);
  await client.callOrThrow("/api/zones/list");
  const call = srv.calls.find((c) => c.url.endsWith("/api/zones/list"));
  assert.equal(call?.form.get("token"), srv.minted[0]);
});

test("each session gets its own token; none is reused", async () => {
  const srv = fakeServer();
  const a = new TechnitiumClient(sessionConfig());
  const b = new TechnitiumClient(sessionConfig());
  await a.startSession();
  await b.startSession();
  assert.equal(srv.minted.length, 2);
  assert.notEqual(srv.minted[0], srv.minted[1]);
  await a.logout();
  await b.logout();
  assert.deepEqual([...srv.revoked].sort(), [...srv.minted].sort());
});

test("logout sends this session's token to /api/user/logout once", async () => {
  const srv = fakeServer();
  const client = new TechnitiumClient(sessionConfig());
  await client.startSession();
  await client.logout();
  await client.logout(); // second call is a no-op
  assert.equal(logouts(srv.calls).length, 1);
  assert.equal(logouts(srv.calls)[0].form.get("token"), srv.minted[0]);
  assert.ok(srv.revoked.has(srv.minted[0]));
});

test("after logout the client cannot log in again", async () => {
  const srv = fakeServer();
  const client = new TechnitiumClient(sessionConfig());
  await client.startSession();
  await client.logout();
  await assert.rejects(() => client.callOrThrow("/api/zones/list"), /Session closed/);
  assert.equal(logins(srv.calls).length, 1, "no second login after logout");
});

test("logout never throws, even when the request fails", async () => {
  fakeServer({ failLogout: true });
  const client = new TechnitiumClient(sessionConfig());
  await client.startSession();
  await client.logout();
});

test("startSession fails closed on a rejected login and holds no token", async () => {
  const srv = fakeServer({ loginStatus: "error" });
  const client = new TechnitiumClient(sessionConfig());
  await assert.rejects(() => client.startSession(), /Authentication failed/);
  await client.logout();
  assert.equal(logouts(srv.calls).length, 0, "nothing to revoke");
});

test("outside session mode, startSession and logout make no requests", async () => {
  const srv = fakeServer();
  const client = new TechnitiumClient({ ...sessionConfig(), sessionMode: undefined });
  await client.startSession();
  await client.logout();
  assert.equal(srv.calls.length, 0);
});

test("an expired session token is replaced by a fresh login, not reused", async () => {
  const calls: Recorded[] = [];
  const minted: string[] = [];
  let rejectNext = true;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), form: new URLSearchParams(init?.body ?? "") });
    const json = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (String(url).endsWith("/api/user/login")) {
      const token = rnd("sess");
      minted.push(token);
      return json({ status: "ok", response: { token } });
    }
    if (rejectNext) {
      rejectNext = false;
      return json({ status: "invalid-token" });
    }
    return json({ status: "ok", response: { done: true } });
  };
  const client = new TechnitiumClient(sessionConfig());
  await client.startSession();
  await client.callOrThrow("/api/zones/list");
  assert.equal(minted.length, 2);
  assert.notEqual(minted[0], minted[1]);
  assert.equal(calls[calls.length - 1].form.get("token"), minted[1]);
});

test("neither the password nor any token is written to stderr", async () => {
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  const cfg = sessionConfig();
  let srv: ReturnType<typeof fakeServer>;
  try {
    srv = fakeServer();
    const client = new TechnitiumClient(cfg);
    await client.startSession();
    await client.callOrThrow("/api/zones/list");
    await client.logout();
  } finally {
    (process.stderr as { write: unknown }).write = realWrite;
  }
  const out = written.join("");
  assert.ok(out.length > 0, "audit lines were captured");
  assert.ok(!out.includes(cfg.password as string), "password leaked to stderr");
  for (const t of srv.minted) assert.ok(!out.includes(t), "token leaked to stderr");
});
