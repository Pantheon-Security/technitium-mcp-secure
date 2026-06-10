import { isIP } from "node:net";
import { ValidationError } from "./errors.js";

const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export function validateDomain(domain: string): string {
  if (!domain || typeof domain !== "string") {
    throw new ValidationError("Domain name is required");
  }
  const trimmed = domain.trim().toLowerCase();
  if (trimmed.length > 253) {
    throw new ValidationError("Domain name exceeds maximum length of 253 characters");
  }
  if (!DOMAIN_RE.test(trimmed)) {
    throw new ValidationError("Invalid domain name format");
  }
  return trimmed;
}

export function validateIp(ip: string): string {
  if (!ip || typeof ip !== "string") {
    throw new ValidationError("IP address is required");
  }
  const trimmed = ip.trim();
  if (isIP(trimmed) === 0) {
    throw new ValidationError("Invalid IP address format");
  }
  return trimmed;
}

export function validateIpOrHostname(value: string): string {
  if (!value || typeof value !== "string") {
    throw new ValidationError("Server address is required");
  }
  const trimmed = value.trim();
  // Bare IPs and hostnames are allowed even when private — querying or
  // forwarding to an internal resolver (e.g. 192.168.1.1) is a normal homelab
  // use. An https:// value is a DoH endpoint the server fetches over HTTP, so
  // it carries SSRF risk and goes through the public-URL guard.
  if (isIP(trimmed) !== 0) {
    return trimmed;
  }
  if (trimmed.startsWith("https://")) {
    return validatePublicHttpUrl(trimmed);
  }
  if (DOMAIN_RE.test(trimmed) && trimmed.length <= 253) {
    return trimmed;
  }
  throw new ValidationError("Invalid server address: must be IP, hostname, or https:// URL");
}

const VALID_RECORD_TYPES = new Set([
  "A", "AAAA", "CNAME", "MX", "NS", "PTR", "SOA", "SRV", "TXT", "CAA", "ANY",
]);

export function validateRecordType(type: string): string {
  if (!type || typeof type !== "string") {
    throw new ValidationError("Record type is required");
  }
  const upper = type.trim().toUpperCase();
  if (!VALID_RECORD_TYPES.has(upper)) {
    throw new ValidationError(`Invalid record type: ${upper}`);
  }
  return upper;
}

const VALID_PERIODS = new Set([
  "LastHour", "LastDay", "LastWeek", "LastMonth", "LastYear",
]);

export function validatePeriod(period: string): string {
  if (!VALID_PERIODS.has(period)) {
    throw new ValidationError(`Invalid period: ${period}. Valid: ${[...VALID_PERIODS].join(", ")}`);
  }
  return period;
}

const VALID_PROTOCOLS = new Set(["Udp", "Tcp", "Tls", "Https", "Quic"]);

export function validateProtocol(protocol: string): string {
  if (!VALID_PROTOCOLS.has(protocol)) {
    throw new ValidationError(`Invalid protocol: ${protocol}`);
  }
  return protocol;
}

const VALID_ZONE_TYPES = new Set(["Primary", "Secondary", "Stub", "Forwarder"]);

export function validateZoneType(type: string): string {
  if (!VALID_ZONE_TYPES.has(type)) {
    throw new ValidationError(`Invalid zone type: ${type}`);
  }
  return type;
}

export function validateStringLength(value: string, maxLength: number, fieldName: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${fieldName} exceeds maximum length of ${maxLength}`);
  }
  return value;
}

const MAX_SETTING_LENGTH = 4096;

/** Split a comma-separated settings value, trimming and dropping blanks. */
function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate the comma-separated `forwarders` setting: each entry must be an IP,
 * hostname, or https:// DoH URL. Stops an injected setSettings from pointing
 * resolution at an attacker-controlled resolver via a junk value.
 */
export function validateForwarders(value: string): string {
  validateStringLength(value, MAX_SETTING_LENGTH, "forwarders");
  const entries = splitCsv(value);
  if (entries.length === 0) return value; // empty clears forwarders
  return entries.map((e) => validateIpOrHostname(e)).join(", ");
}

/** Validate an IP or IP/CIDR entry (used for the reverse-proxy trust ACL). */
export function validateCidrOrIp(entry: string): string {
  const trimmed = entry.trim();
  const slash = trimmed.indexOf("/");
  const ip = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefix = slash === -1 ? undefined : trimmed.slice(slash + 1);
  const fam = isIP(ip);
  if (fam === 0) {
    throw new ValidationError(`Invalid IP in network ACL: ${entry}`);
  }
  if (prefix !== undefined) {
    const p = Number(prefix);
    const max = fam === 4 ? 32 : 128;
    if (!Number.isInteger(p) || p < 0 || p > max) {
      throw new ValidationError(`Invalid CIDR prefix in network ACL: ${entry}`);
    }
  }
  return trimmed;
}

/**
 * Validate the `reverseProxyNetworkACL` setting. Entries decide which client
 * IPs are trusted to set X-Real-IP, so an unvalidated value enables source-IP
 * spoofing — each entry must be a real IP or CIDR.
 */
export function validateReverseProxyAcl(value: string): string {
  validateStringLength(value, MAX_SETTING_LENGTH, "reverseProxyNetworkACL");
  return splitCsv(value).map(validateCidrOrIp).join(", ");
}

const PRIVATE_IPV4_RE = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^0\./,
];

/**
 * Validate a server-side-fetched block-list URL. Must be http(s) and must not
 * target a literal loopback/link-local/private address — a proportionate guard
 * against an injected setSettings turning the DNS server into an SSRF proxy.
 * (Hostnames are allowed; full rebinding defence would require resolution.)
 */
export function validatePublicHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`Invalid block list URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(`Block list URL must be http(s): ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost") {
    throw new ValidationError(`Block list URL must not target localhost: ${raw}`);
  }
  const fam = isIP(host);
  if (fam === 4 && PRIVATE_IPV4_RE.some((re) => re.test(host))) {
    throw new ValidationError(`Block list URL must not target a private address: ${raw}`);
  }
  if (
    fam === 6 &&
    (host === "::1" ||
      host.startsWith("fe80") ||
      host.startsWith("fc") ||
      host.startsWith("fd"))
  ) {
    throw new ValidationError(`Block list URL must not target a private address: ${raw}`);
  }
  return raw;
}

/** Validate the comma-separated `blockListUrls` setting. */
export function validateBlockListUrls(value: string): string {
  validateStringLength(value, MAX_SETTING_LENGTH, "blockListUrls");
  return splitCsv(value).map(validatePublicHttpUrl).join(", ");
}
