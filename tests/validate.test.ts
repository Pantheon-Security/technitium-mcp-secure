import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDomain,
  validateIp,
  validateIpOrHostname,
  validateRecordType,
  validatePeriod,
  validateProtocol,
  validateZoneType,
  validateStringLength,
} from "../src/validate.js";

test("validateDomain accepts and normalises valid names", () => {
  assert.equal(validateDomain("Example.COM"), "example.com");
  assert.equal(validateDomain("  sub.example.com  "), "sub.example.com");
});

test("validateDomain rejects injection and malformed input", () => {
  for (const bad of ["", "exa mple.com", "a/../b", "x;rm -rf", "-bad.com", "a".repeat(254)]) {
    assert.throws(() => validateDomain(bad as string), /required|Invalid|exceeds/);
  }
});

test("validateIp accepts v4 and v6, rejects junk", () => {
  assert.equal(validateIp("192.168.1.1"), "192.168.1.1");
  assert.equal(validateIp("2001:db8::1"), "2001:db8::1");
  assert.throws(() => validateIp("999.1.1.1"), /Invalid/);
  assert.throws(() => validateIp("not-an-ip"), /Invalid/);
});

test("validateIpOrHostname accepts ip, hostname, https url", () => {
  assert.equal(validateIpOrHostname("1.1.1.1"), "1.1.1.1");
  assert.equal(validateIpOrHostname("dns.example.com"), "dns.example.com");
  assert.equal(validateIpOrHostname("https://dns.google/dns-query"), "https://dns.google/dns-query");
  assert.throws(() => validateIpOrHostname("ftp://x"), /Invalid/);
});

test("validateRecordType normalises case and rejects unknown", () => {
  assert.equal(validateRecordType("a"), "A");
  assert.equal(validateRecordType("txt"), "TXT");
  assert.throws(() => validateRecordType("NOTAREC"), /Invalid record type/);
});

test("enum validators reject out-of-set values", () => {
  assert.equal(validatePeriod("LastDay"), "LastDay");
  assert.throws(() => validatePeriod("LastDecade"), /Invalid period/);
  assert.equal(validateProtocol("Https"), "Https");
  assert.throws(() => validateProtocol("Carrier"), /Invalid protocol/);
  assert.equal(validateZoneType("Primary"), "Primary");
  assert.throws(() => validateZoneType("Tertiary"), /Invalid zone type/);
});

test("validateStringLength enforces cap", () => {
  assert.equal(validateStringLength("ok", 10, "f"), "ok");
  assert.throws(() => validateStringLength("toolong", 3, "f"), /exceeds maximum length/);
});
