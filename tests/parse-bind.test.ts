import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBind } from "../src/tools/records.js";

test("parses a basic A record with relative name", () => {
  const recs = parseBind("example.com", "www 3600 IN A 1.2.3.4");
  assert.deepEqual(recs, [
    { name: "www.example.com", ttl: 3600, type: "A", value: "1.2.3.4" },
  ]);
});

test("@ apex maps to the zone name", () => {
  const recs = parseBind("example.com", "@ 3600 IN A 1.2.3.4");
  assert.equal(recs[0].name, "example.com");
});

test("absolute FQDN keeps its name minus the trailing dot", () => {
  const recs = parseBind("example.com", "mail.example.com. 300 IN A 9.9.9.9");
  assert.equal(recs[0].name, "mail.example.com");
});

test("TXT rdata with spaces is preserved as a single value", () => {
  const recs = parseBind("example.com", '@ 3600 IN TXT "v=spf1 include:_spf.x.com ~all"');
  assert.equal(recs[0].type, "TXT");
  assert.equal(recs[0].value, '"v=spf1 include:_spf.x.com ~all"');
});

test("skips comments, directives, blanks, and malformed lines", () => {
  const bind = [
    "; a comment",
    "$ORIGIN example.com.",
    "",
    "short line",
    "@ notanumber IN A 1.2.3.4",
    "www 60 IN A 5.6.7.8",
  ].join("\n");
  const recs = parseBind("example.com", bind);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].name, "www.example.com");
});

test("returns empty array for empty or whitespace input", () => {
  assert.deepEqual(parseBind("example.com", ""), []);
  assert.deepEqual(parseBind("example.com", "   \n  \n"), []);
});

test("$TTL-inherited records (no explicit ttl) are kept, not dropped", () => {
  const recs = parseBind("example.com", "$TTL 3600\nwww IN A 1.2.3.4");
  assert.deepEqual(recs, [
    { name: "www.example.com", ttl: 3600, type: "A", value: "1.2.3.4" },
  ]);
});

test("parenthesised multi-line records (SOA) parse as a single record", () => {
  const bind = [
    "@ 3600 IN SOA ns1.example.com. admin.example.com. (",
    "    2026010101 ; serial",
    "    7200       ; refresh",
    "    3600       ; retry",
    "    1209600    ; expire",
    "    3600 )     ; minimum",
  ].join("\n");
  const recs = parseBind("example.com", bind);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, "SOA");
  assert.match(recs[0].value, /ns1\.example\.com\. admin\.example\.com\. 2026010101 7200 3600 1209600 3600/);
});

test("relative names with dots are made relative to the origin, not treated as absolute", () => {
  const recs = parseBind("example.com", "sub.www 300 IN A 1.2.3.4");
  assert.equal(recs[0].name, "sub.www.example.com");
});

test("$ORIGIN overrides the zone for relative names", () => {
  const recs = parseBind("example.com", "$ORIGIN sub.example.com.\nhost 60 IN A 1.2.3.4");
  assert.equal(recs[0].name, "host.sub.example.com");
});

test("blank-owner continuation lines reuse the previous owner", () => {
  const recs = parseBind("example.com", "www 300 IN A 1.2.3.4\n    300 IN A 5.6.7.8");
  assert.equal(recs.length, 2);
  assert.equal(recs[0].name, "www.example.com");
  assert.equal(recs[1].name, "www.example.com");
  assert.equal(recs[1].value, "5.6.7.8");
});
