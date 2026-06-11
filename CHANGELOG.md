# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.4] - 2026-06-11

Tooling, supply-chain, and a tool-contract cleanup. 92 tests; lint clean.

### Security

- Took the previously-deferred high-severity transitive advisory fixes now that
  their patches passed the 30-day rule: `hono` 4.12.18, `express-rate-limit`
  8.5.1, `ip-address` 10.2.0 (pinned via overrides, age-checked + logged). The
  CI `npm audit` gate is raised from `critical` to `high`. Remaining advisories
  are all moderate and still held by the rule.

### Added

- Biome linter (pinned `@biomejs/biome` 2.4.15), `npm run lint`, and a CI lint
  step. Fixed all findings (import-type, `Number.isNaN`, unused import, …).
- `server.json` MCP-registry manifest (env vars documented) and a `mcpName` in
  package.json for registry ownership verification.
- `outputSchema` on `dns_health_check` (a trusted, stable-shaped tool). Untrusted
  tools intentionally omit it — an outputSchema would oblige them to emit
  `structuredContent`, which the prompt-injection fence withholds.

### Changed

- **`dns_list_records` now returns one stable shape** instead of three. Always
  `{ zone, zones, recordCount, records }` (plus `domain`/`errors` when relevant),
  with a flat normalized `records` array. All cases — single zone, parent/
  subzone, and exact-domain filter — go through the one tested export+parse path
  rather than a separate raw API record format. This is a response-shape change
  for consumers of the old per-case shapes.

## [1.3.3] - 2026-06-10

Quality refactors from the re-review backlog — behaviour-preserving, all gates
green (87 tests).

### Changed

- Tool handlers now return their result as a value; the dispatcher owns
  sanitization and JSON serialization (removes the double parse/stringify round
  trip and the parse-and-catch in the response path).
- Record-type → API-field mapping extracted into one `RECORD_FIELDS` descriptor
  table driving add/update/delete (previously hand-written three times and a
  source of drift bugs). TXT values are now length-bounded on add/update too.
- `dns_set_settings` / `dns_set_zone_options` derive their handler allowlist
  from the shared schema-properties object instead of a duplicate key list.

### Added

- `idempotentHint` annotation on set-state writes, deletes, and flushes.

## [1.3.2] - 2026-06-10

Clears the substantive pre-existing backlog from the re-review (none blocked
the GO verdict). All fixes carry red-proven regression gates (85 tests).

### Security

- Response value strings are now scrubbed of file paths, stack traces, and
  credential URLs (previously only long hex was redacted), and the per-zone
  export error is routed through `sanitizeError` instead of embedding a raw
  `String(e)`.
- `dns_delete_record` validates the value for its record type before echoing it
  in the confirmation message or forwarding it.

### Fixed

- **Client auth reliability.** A revoked static token no longer triggers a
  double round-trip ending in a confusing UpstreamError — it now fails fast
  with an AuthError when no password is configured to re-authenticate.
  Concurrent invalid-token handling uses compare-and-swap on the failed token
  so a freshly acquired token can't be clobbered (no `token=null` retries).
- **BIND parsing.** `parseBind` now keeps `$TTL`-inherited records, parses
  parenthesised multi-line records (SOA) as one record, honours `$ORIGIN` and
  blank-owner continuation lines, and resolves relative dotted names correctly
  instead of mistaking them for absolute names. (Removed the dead `origin` var.)

### Changed

- `VERSION` is read from `package.json` at runtime (single source of truth).
- Published `bin` is marked executable on build (`postbuild` chmod) so `npx`
  works.
- Extracted named constants for the rate-limit tiers; hoisted the response
  token regex out of the per-value hot path.

## [1.3.1] - 2026-06-10

Closes gaps an adversarial re-review found in the 1.3.0 remediation (verdict
was GO; these were the incomplete fixes). All carry red-proven regression gates.

### Security

- **structuredContent fence bypass.** Untrusted DNS data was fenced in the text
  channel but returned unfenced via `structuredContent`. Untrusted tools now
  emit fenced text only — never structuredContent.
- **SSRF in `validateIpOrHostname`.** `dns_resolve`'s `server` param accepted
  `https://` DoH URLs to loopback/metadata/private hosts; that branch now goes
  through the public-URL guard. Bare IPs/hostnames remain allowed (internal
  resolvers are a legitimate homelab use).
- **Validation drift in `dns_set_zone_options`.** `zoneTransferAllowedNetworks`
  / `notifyNameServers` were forwarded unvalidated; they now use the same
  per-key validators as `dns_set_settings`.

### Fixed

- `dns_add_record` advertised SOA/SRV/CAA it could not add (always failed
  upstream); enum trimmed to supported types with an explicit reject otherwise.
- `ttl=0` / `priority=0` were dropped by truthiness checks despite the schema
  allowing `minimum: 0`; now forwarded via `!== undefined`.

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

[1.3.4]: https://github.com/rosschurchill/technitium-mcp-secure/releases/tag/v1.3.4
[1.3.3]: https://github.com/rosschurchill/technitium-mcp-secure/releases/tag/v1.3.3
[1.3.2]: https://github.com/rosschurchill/technitium-mcp-secure/releases/tag/v1.3.2
[1.3.1]: https://github.com/rosschurchill/technitium-mcp-secure/releases/tag/v1.3.1
[1.3.0]: https://github.com/rosschurchill/technitium-mcp-secure/releases/tag/v1.3.0
