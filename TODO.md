# technitium-mcp — TODO

Gaps discovered during real use of the MCP server. Captured here so they don't get lost.

## High priority — DONE 2026-05-04

Patched directly in `dist/` (src is empty) while standing up a downstream ACME / internal CA integration. If/when you restore source from git, port these changes back. They are simple allowlist + schema additions — no logic changes.

### `dns_set_settings` — TLS web-service knobs ✅

Now exposes 17 keys (was 8). Added:

| Key | Type | Purpose |
|---|---|---|
| `webServiceEnableTls` | bool | Master toggle for HTTPS on the admin UI |
| `webServiceTlsCertificatePath` | string | Path to PFX file inside container (relative to `/etc/dns`) |
| `webServiceTlsCertificatePassword` | string (write-only) | PFX passphrase. Server returns `[REDACTED]` on read |
| `webServiceTlsPort` | int | TLS listen port (default 53443) |
| `webServiceHttpToTlsRedirect` | bool | 301 from HTTP to HTTPS |
| `webServiceUseSelfSignedTlsCertificate` | bool | Auto-generate self-signed if no cert configured |
| `webServiceLocalAddresses` | string[] | Bind addresses (e.g. `[::]`) |
| `webServiceHttpPort` | int | HTTP listen port (default 5380) |
| `webServiceEnableHttp3` | bool | HTTP/3 on the TLS port |

API endpoint: `POST /api/settings/set?token=...&webServiceEnableTls=true&...`

### `dns_set_zone_options` — notify mode + access controls ✅

Now exposes 10 keys (was 3). Added:

| Key | Type | Purpose |
|---|---|---|
| `notify` | enum | `None` / `ZoneNameServers` / `SpecifiedNameServers` / `BothZoneAndSpecifiedNameServers` |
| `queryAccess` | enum | `Allow` / `Deny` / `AllowOnlyPrivateNetworks` / `UseSpecifiedNetworkACL` |
| `queryAccessNetworkACL` | string[] | Network ACL when `UseSpecifiedNetworkACL` |
| `update` | enum | `Allow` / `Deny` / `AllowOnlyZoneNameServers` / `UseSpecifiedNetworkACL` / `UseSpecifiedSecurityPolicies` |
| `updateNetworkACL` | string[] | Network ACL for dynamic updates |
| `updateSecurityPolicies` | object[] | TSIG-key-based update policies |
| `catalog` | string | Catalog zone membership |
| `zoneTransfer` | enum | Already implicit in `zoneTransferAllowedNetworks` but the mode itself isn't exposed |

API endpoint: `POST /api/zones/options/set?token=...&zone=X&notify=None&...`

## Medium priority — observed but not blocking

### Token auth at MCP startup is silent on permission scope

The `~/.technitium-token` is loaded with full admin scope. There's no MCP-side enforcement of read-only mode beyond hiding write tools. If `TECHNITIUM_READONLY=true`, it should also reject `set_*` tool calls server-side as belt-and-braces.

### No `dns_get_zone` or `dns_zone_info` distinct from `dns_zone_options`

`dns_zone_options` returns config; nothing returns the SOA, modification timestamps, record count, or zone-level metadata in one call. `dns_list_zones` does it for ALL zones — useful but coarse.

### No way to set zone NS records via API

When creating a primary zone, the auto-generated SOA + NS records use the server's default. To set a custom NS, you have to add a record explicitly — but `dns_add_record` for type=NS works fine, so this is more of a documentation gap than a missing tool.

## Low priority — nice to have

- `dns_create_token` — currently done via curl in an external bootstrap script. Adding it would let Claude rotate its own token.
- `dns_list_tokens` / `dns_revoke_token` — for housekeeping.
- `dns_get_logs` — direct access to log files (currently `dns_query_logs` is only for the structured query log app).
- DHCP scope/lease tools — already noted in README "Not Yet Implemented" section.

## Implementation notes

- All settings endpoints accept multiple `key=value` query params in one POST. The MCP can pass through any subset cleanly.
- For passwords/secrets, the MCP should mark fields as write-only (don't echo back even if API returns `[REDACTED]`).
- After server-side rebuild, the MCP must be reloaded by Claude Code (`/clear` or session restart) for new tool schemas to appear.
