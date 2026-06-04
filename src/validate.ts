import { isIP } from "node:net";

const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export function validateDomain(domain: string): string {
  if (!domain || typeof domain !== "string") {
    throw new Error("Domain name is required");
  }
  const trimmed = domain.trim().toLowerCase();
  if (trimmed.length > 253) {
    throw new Error("Domain name exceeds maximum length of 253 characters");
  }
  if (!DOMAIN_RE.test(trimmed)) {
    throw new Error("Invalid domain name format");
  }
  return trimmed;
}

export function validateIp(ip: string): string {
  if (!ip || typeof ip !== "string") {
    throw new Error("IP address is required");
  }
  const trimmed = ip.trim();
  if (isIP(trimmed) === 0) {
    throw new Error("Invalid IP address format");
  }
  return trimmed;
}

export function validateIpOrHostname(value: string): string {
  if (!value || typeof value !== "string") {
    throw new Error("Server address is required");
  }
  const trimmed = value.trim();
  if (isIP(trimmed) !== 0) {
    return trimmed;
  }
  if (trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (DOMAIN_RE.test(trimmed) && trimmed.length <= 253) {
    return trimmed;
  }
  throw new Error("Invalid server address: must be IP, hostname, or https:// URL");
}

const VALID_RECORD_TYPES = new Set([
  "A", "AAAA", "CNAME", "MX", "NS", "PTR", "SOA", "SRV", "TXT", "CAA", "ANY",
]);

export function validateRecordType(type: string): string {
  if (!type || typeof type !== "string") {
    throw new Error("Record type is required");
  }
  const upper = type.trim().toUpperCase();
  if (!VALID_RECORD_TYPES.has(upper)) {
    throw new Error(`Invalid record type: ${upper}`);
  }
  return upper;
}

const VALID_PERIODS = new Set([
  "LastHour", "LastDay", "LastWeek", "LastMonth", "LastYear",
]);

export function validatePeriod(period: string): string {
  if (!VALID_PERIODS.has(period)) {
    throw new Error(`Invalid period: ${period}. Valid: ${[...VALID_PERIODS].join(", ")}`);
  }
  return period;
}

const VALID_PROTOCOLS = new Set(["Udp", "Tcp", "Tls", "Https", "Quic"]);

export function validateProtocol(protocol: string): string {
  if (!VALID_PROTOCOLS.has(protocol)) {
    throw new Error(`Invalid protocol: ${protocol}`);
  }
  return protocol;
}

const VALID_ZONE_TYPES = new Set(["Primary", "Secondary", "Stub", "Forwarder"]);

export function validateZoneType(type: string): string {
  if (!VALID_ZONE_TYPES.has(type)) {
    throw new Error(`Invalid zone type: ${type}`);
  }
  return type;
}

export function validateStringLength(value: string, maxLength: number, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength}`);
  }
  return value;
}
