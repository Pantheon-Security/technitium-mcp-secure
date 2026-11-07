import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Lifecycle, installProcessHandlers, runGuarded } from "../src/lifecycle.js";

const rnd = (label: string): string => `${label}-${randomBytes(9).toString("hex")}`;

function fakeClient(opts: { logoutThrows?: boolean; logoutHangs?: boolean } = {}) {
  const c = {
    logouts: 0,
    cleared: 0,
    async logout() {
      c.logouts++;
      if (opts.logoutThrows) throw new Error("boom");
      if (opts.logoutHangs) await new Promise(() => undefined);
    },
    clearToken() {
      c.cleared++;
    },
  };
  return c;
}

function quietAudit<T>(fn: () => Promise<T>): Promise<T> {
  const real = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = () => true;
  return fn().finally(() => {
    (process.stderr as { write: unknown }).write = real;
  });
}

// ------------------------------------------------------------ unit tests ---

test("shutdown revokes once and exits 0, however many triggers fire", async () => {
  const client = fakeClient();
  const exits: number[] = [];
  const lc = new Lifecycle(client, { exit: (c) => void exits.push(c) });
  await quietAudit(async () => {
    await Promise.all([lc.shutdown("SIGTERM"), lc.shutdown("stdin_end"), lc.shutdown("stdin_close")]);
  });
  assert.equal(client.logouts, 1, "logout called once");
  assert.equal(client.cleared, 1);
  assert.deepEqual(exits, [0]);
});

test("a failing logout still exits", async () => {
  const client = fakeClient({ logoutThrows: true });
  const exits: number[] = [];
  const lc = new Lifecycle(client, { exit: (c) => void exits.push(c) });
  await quietAudit(() => lc.shutdown("SIGINT"));
  assert.deepEqual(exits, [0]);
});

test("a hung logout is cut off by the force-exit timer with code 1", async () => {
  const client = fakeClient({ logoutHangs: true });
  const exits: number[] = [];
  const lc = new Lifecycle(client, { exit: (c) => void exits.push(c), forceExitMs: 40 });
  void quietAudit(() => lc.shutdown("SIGTERM"));
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(exits, [1]);
});

test("startup failure AFTER login revokes the token and exits 1", async () => {
  const client = fakeClient();
  const exits: number[] = [];
  const lc = new Lifecycle(client, { exit: (c) => void exits.push(c) });
  await quietAudit(() =>
    runGuarded(lc, async () => {
      // stands in for: startSession() succeeded, then connect/tool setup threw
      throw new Error("transport failed");
    })
  );
  assert.equal(client.logouts, 1, "token revoked");
  assert.deepEqual(exits, [1]);
});

test("every exit trigger is installed, and a crash revokes the token and exits 1", async () => {
  const client = fakeClient();
  const exits: number[] = [];
  const lc = new Lifecycle(client, { exit: (c) => void exits.push(c) });
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const stdin = new Map<string, () => void>();
  installProcessHandlers(lc, {
    on: (e, l) => void handlers.set(e, l),
    stdin: { on: (e, l) => void stdin.set(e, l) },
  });
  for (const ev of ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"]) {
    assert.ok(handlers.has(ev), `${ev} handler installed`);
  }
  assert.ok(stdin.has("end") && stdin.has("close"));
  await quietAudit(async () => {
    handlers.get("uncaughtException")!(new Error("kaboom"));
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(client.logouts, 1);
  assert.deepEqual(exits, [1]);
});

// ------------------------------------------- end to end, real child process ---

interface Hit {
  path: string;
  form: URLSearchParams;
}

async function withMockServer(
  loginOk: boolean,
  run: (url: string, hits: Hit[], minted: string[]) => Promise<void>
) {
  const hits: Hit[] = [];
  const minted: string[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", form: new URLSearchParams(body) });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/user/login") {
        if (!loginOk) return void res.end(JSON.stringify({ status: "error", errorMessage: "no" }));
        const token = rnd("sess");
        minted.push(token);
        return void res.end(JSON.stringify({ status: "ok", response: { token } }));
      }
      res.end(JSON.stringify({ status: "ok", response: {} }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const port = (srv.address() as AddressInfo).port;
    await run(["http", "://127.0.0.1:", port].join(""), hits, minted);
  } finally {
    srv.close();
  }
}

// Compiled layout: .test-build/tests/lifecycle.test.js -> .test-build/src/index.js
const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

function runServer(url: string) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      PATH: process.env.PATH ?? "",
      TECHNITIUM_URL: url,
      TECHNITIUM_ALLOW_HTTP: "1",
      TECHNITIUM_SESSION_USER: rnd("u"),
      TECHNITIUM_SESSION_PASS: rnd("p"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const started = new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (stderr.includes('"event":"startup"')) {
        clearInterval(t);
        resolve();
      }
    }, 20);
    child.on("exit", () => {
      clearInterval(t);
      resolve();
    });
  });
  return { child, exited, started, err: () => stderr };
}

test("e2e: SIGTERM logs out the token this process minted", async () => {
  await withMockServer(true, async (url, hits, minted) => {
    const s = runServer(url);
    await s.started;
    s.child.kill("SIGTERM");
    assert.equal(await s.exited, 0);
    assert.equal(minted.length, 1);
    const outs = hits.filter((h) => h.path === "/api/user/logout");
    assert.equal(outs.length, 1);
    assert.equal(outs[0].form.get("token"), minted[0]);
    assert.ok(!s.err().includes(minted[0]), "token not in stderr");
  });
});

test("e2e: closing stdin logs out the token", async () => {
  await withMockServer(true, async (url, hits, minted) => {
    const s = runServer(url);
    await s.started;
    s.child.stdin.end();
    assert.equal(await s.exited, 0);
    const outs = hits.filter((h) => h.path === "/api/user/logout");
    assert.equal(outs.length, 1);
    assert.equal(outs[0].form.get("token"), minted[0]);
  });
});

test("e2e: a rejected login exits 1 and sends no logout", async () => {
  await withMockServer(false, async (url, hits) => {
    const s = runServer(url);
    assert.equal(await s.exited, 1);
    assert.equal(hits.filter((h) => h.path === "/api/user/logout").length, 0);
  });
});
