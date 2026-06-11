# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use CalVer
(`YYYY.FEATURE.PATCH`).

## [2026.1.0] - 2026-06-11

Initial public release. A security-hardened MCP server for the Technitium DNS
admin API — tools across zones, records, blocking, cache, settings, apps,
DNSSEC, query logs, and diagnostics.

### Security

- Prompt-injection fence on all tool output carrying third-party DNS data
  (resolved records, query logs, blocklist imports, app-store metadata).
- Privileged-settings validation: forwarders (DNS-hijack), `blockListUrls`
  (server-side SSRF), `reverseProxyNetworkACL` (X-Real-IP spoofing), and the
  zone-transfer/notify ACLs.
- Exact dependency pinning with a committed, reviewed lockfile; CI `npm audit`
  gate; Biome lint; SHA-pinned GitHub Actions.
- Output scrubbing (tokens, credentials, file paths, stack traces); session
  token sent only in POST bodies; readonly mode; `confirm`-gated destructive
  tools; tiered rate limiting.

### Reliability

- Hardened HTTP client: per-request timeouts, `resp.ok` checks, single re-auth
  retry with compare-and-swap, fail-fast on a revoked static token.
- Robust BIND parser ($TTL/$ORIGIN, multi-line records, continuation lines).
- Bounded `dns_list_records` (parallel exports, zone/record caps, `truncated`
  flag) and capped flat list tools.

### Tooling

- 108-test `node:test` suite with red-proven regression gates.
- `server.json` for the MCP registry; published bin marked executable for `npx`.

[2026.1.0]: https://github.com/Pantheon-Security/technitium-mcp-secure/releases/tag/v2026.1.0
