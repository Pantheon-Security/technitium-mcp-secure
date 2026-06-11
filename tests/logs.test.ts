import { test } from "node:test";
import assert from "node:assert/strict";
import { logTools } from "../src/tools/logs.js";
import type { TechnitiumClient } from "../src/client.js";

function queryParams(args: Record<string, unknown>) {
  let captured: Record<string, string> | undefined;
  const fake = {
    callOrThrow: async (_e: string, params?: Record<string, string>) => {
      captured = params;
      return {};
    },
  } as unknown as TechnitiumClient;
  const t = logTools(fake).find((x) => x.definition.name === "dns_query_logs")!;
  return t.handler(args).then(() => captured!);
}

test("entriesPerPage is floored at 1 (negatives no longer pass through)", async () => {
  const p = await queryParams({ entriesPerPage: -5 });
  assert.equal(p.entriesPerPage, "1");
});

test("entriesPerPage is capped at the max", async () => {
  const p = await queryParams({ entriesPerPage: 99999 });
  assert.equal(p.entriesPerPage, "100");
});

test("pageNumber is floored at 1", async () => {
  const p = await queryParams({ pageNumber: -3 });
  assert.equal(p.pageNumber, "1");
});
