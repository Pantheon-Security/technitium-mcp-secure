import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateForwarders,
  validateReverseProxyAcl,
  validateBlockListUrls,
  validateCidrOrIp,
  validatePublicHttpUrl,
} from "../src/validate.js";

test("validateForwarders accepts IPs, hostnames, and DoH URLs", () => {
  assert.equal(validateForwarders("1.1.1.1, dns.google"), "1.1.1.1, dns.google");
  assert.equal(
    validateForwarders("https://dns.google/dns-query"),
    "https://dns.google/dns-query"
  );
});

test("validateForwarders rejects a junk/injected entry", () => {
  assert.throws(() => validateForwarders("1.1.1.1, ; rm -rf /"), /Invalid/);
});

test("validateReverseProxyAcl accepts IPs and CIDRs, rejects junk", () => {
  assert.equal(validateReverseProxyAcl("10.0.0.1, 192.168.0.0/16"), "10.0.0.1, 192.168.0.0/16");
  assert.throws(() => validateCidrOrIp("10.0.0.0/99"), /CIDR prefix/);
  assert.throws(() => validateCidrOrIp("not-an-ip"), /Invalid IP/);
});

test("validatePublicHttpUrl blocks SSRF to private/loopback/metadata targets", () => {
  for (const bad of [
    "http://127.0.0.1/list.txt",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/x",
    "http://192.168.1.1/x",
    "http://localhost/x",
    "file:///etc/passwd",
    "ftp://example.com/x",
  ]) {
    assert.throws(() => validatePublicHttpUrl(bad), /must|Invalid/, `should reject ${bad}`);
  }
});

test("validateBlockListUrls accepts public https lists", () => {
  const v = "https://example.com/a.txt, https://lists.example.org/b.txt";
  assert.equal(validateBlockListUrls(v), v);
});
