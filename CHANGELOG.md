# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-06-10

A security and reliability release following a full code review. Hardens the
HTTP client, adds a test suite and CI, and tightens the MCP tool surface.

### Security

- **Prompt-injection fencing.** Responses containing third-party-controlled
  text (resolved records, query logs, blocklist imports, app-store metadata)
  are wrapped in untrusted-data markers so injected instructions are presented
  to the model as data, not directives.
- **Privileged settings validation.** `dns_set_settings` now validates
  `forwarders` (DNS-hijack), `reverseProxyNetworkACL` (X-Real-IP spoofing),
  and `blockListUrls` (server-side SSRF — loopback/link-local/private/metadata
  targets are rejected) instead of forwarding raw values.
- **Token no longer placed in URLs.** The session token always travels in the
  POST body; the GET zone-export path that exposed it to proxy/web-server
  access logs is gone.
- **Exact dependency pinning.** All dependencies pinned to exact versions with
  a committed, reviewed lockfile; transitive advisories patched where the fix
  satisfies the project's supply-chain policy. CI runs `npm audit`.
- Credential-redaction now catches casing/suffix key variants (e.g. `APIKey`,
  `proxyPassword`), and the audit log reuses the same canonical rule.

### Added

- Node `node:test` suite (55 tests) covering the security-boundary modules,
  BIND parsing, and the HTTP client; GitHub Actions CI (build + test + audit,
  SHA-pinned actions).
- Machine-readable tool annotations (`readOnlyHint`, `destructiveHint`,
  `openWorldHint`) on every tool.
- `structuredContent` on tool responses for SDK-aware hosts.
- `SECURITY.md` and this changelog. `files` whitelist + `prepublishOnly` so
  published tarballs ship only `dist/` (previously leaked `src/` and `TODO.md`).
- Typed error hierarchy (`ValidationError` / `UpstreamError` / `AuthError`);
  validation errors are surfaced verbatim and tagged, others sanitized.

### Fixed

- **IPv6 validation.** `validateIp` rejected standard compressed IPv6
  (`2001:db8::1`, `fe80::`, `::ffff:1.2.3.4`), so AAAA-record operations with
  real-world IPv6 addresses failed; now uses `net.isIP()`.
- **HTTP client reliability.** Every request has a 15s timeout; HTTP error
  pages are no longer mistaken for zone data; the post-token-refresh retry is
  re-validated; the three duplicated auth-retry blocks are unified.
- **Record tool enums.** `dns_update_record` now handles NS/PTR (previously
  advertised but silently no-op); `dns_delete_record` handles PTR and no longer
  advertises SRV/CAA it could not delete.
- `dns_health_check` degrades gracefully (one failing dependency no longer
  collapses the whole check); `dns_get_stats` caps each top-N list at 20.
- Strict input schemas (`additionalProperties: false`, numeric bounds);
  `pageNumber` floored at 1; crash handlers log via audit instead of dropping
  the transport silently.

### Changed

- Rate-limit tiers are derived from the registered tools instead of hardcoded
  name lists, so they cannot drift out of sync with a renamed/added tool.

Earlier history (≤ 1.2.4) is available in the git log.

[1.3.0]: https://github.com/rosschurchill/technitium-mcp-secure/releases/tag/v1.3.0
