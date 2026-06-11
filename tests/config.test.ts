import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const KEYS = [
  "TECHNITIUM_URL",
  "TECHNITIUM_TOKEN",
  "TECHNITIUM_PASSWORD",
  "TECHNITIUM_TOKEN_FILE",
  "TECHNITIUM_USER",
  "TECHNITIUM_READONLY",
  "TECHNITIUM_ALLOW_HTTP",
  "TECHNITIUM_STRICT_TOKEN_PERMS",
];

/** Run fn with exactly the given env (the relevant keys), then restore. */
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

test("requires TECHNITIUM_URL", () => {
  withEnv({}, () => assert.throws(() => loadConfig(), /TECHNITIUM_URL/));
});

test("rejects non-http(s) schemes", () => {
  withEnv({ TECHNITIUM_URL: "ftp://x", TECHNITIUM_TOKEN: "t" }, () =>
    assert.throws(() => loadConfig(), /http/)
  );
});

test("uppercase HTTP:// is treated as insecure http, not bypassed", () => {
  withEnv({ TECHNITIUM_URL: "HTTP://dns.local", TECHNITIUM_TOKEN: "t" }, () =>
    assert.throws(() => loadConfig(), /insecure|ALLOW_HTTP/i)
  );
  withEnv(
    { TECHNITIUM_URL: "HTTP://dns.local", TECHNITIUM_TOKEN: "t", TECHNITIUM_ALLOW_HTTP: "true" },
    () => assert.equal(loadConfig().allowHttp, true)
  );
});

test("https loads, strips trailing slash, defaults user to admin", () => {
  withEnv({ TECHNITIUM_URL: "https://dns.local/", TECHNITIUM_TOKEN: "tok" }, () => {
    const c = loadConfig();
    assert.equal(c.url, "https://dns.local");
    assert.equal(c.token, "tok");
    assert.equal(c.user, "admin");
  });
});

test("requires a token or password", () => {
  withEnv({ TECHNITIUM_URL: "https://dns.local" }, () =>
    assert.throws(() => loadConfig(), /TOKEN|PASSWORD/)
  );
});

test("clears sensitive env vars after load", () => {
  withEnv({ TECHNITIUM_URL: "https://dns.local", TECHNITIUM_PASSWORD: "pw" }, () => {
    loadConfig();
    assert.equal(process.env.TECHNITIUM_PASSWORD, undefined);
  });
});

test("STRICT_TOKEN_PERMS fails closed on a group/other-readable token file", () => {
  const tf = join(mkdtempSync(join(tmpdir(), "tmcp-")), "token");
  writeFileSync(tf, "filetoken");
  chmodSync(tf, 0o644);
  withEnv(
    { TECHNITIUM_URL: "https://dns.local", TECHNITIUM_TOKEN_FILE: tf, TECHNITIUM_STRICT_TOKEN_PERMS: "true" },
    () => assert.throws(() => loadConfig(), /loose permissions|STRICT/i)
  );
  // Without strict mode it still loads (warns only).
  withEnv({ TECHNITIUM_URL: "https://dns.local", TECHNITIUM_TOKEN_FILE: tf }, () =>
    assert.equal(loadConfig().token, "filetoken")
  );
});
