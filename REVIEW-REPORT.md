# CODE REVIEW REPORT — technitium-mcp

> Target: full src/ tree + package.json (working tree clean @ 151ec1f, v1.2.4)
> Pillars: Sentinel · Architect · Auditor · Librarian · Skeptic · MCP Developer
> Plus: scaffold mining of notebooklm-mcp-secure (modules, issue archives, infra)
> Generated: 2026-06-04

---

## REMEDIATION STATUS (initial release, 2026-06-10)

This is the **baseline review against v1.2.4**. The report text below is
preserved verbatim as the historical record; most findings have since been
fixed. Remediation landed across four commits (see CHANGELOG.md / git log):

- **CRITICAL** (dependency pinning) — ✅ fixed: exact pins + committed lockfile.
- **HIGH** (lethal-trifecta prompt injection) — ✅ fixed: untrusted-data fence.
- **MEDIUM** — ✅ substantially addressed: HTTP-client timeouts/`resp.ok`/retry
  re-validation, token moved out of URLs, `dns_set_settings` value validation
  (SSRF/forwarder/ACL), record-enum/handler alignment, health-check degradation,
  top-N cap, `structuredContent`, crash handlers, typed errors, named constants.
- **Backlog / protocol** — ✅ done: node:test suite + CI, `files` whitelist +
  `prepublishOnly`, tool annotations, `additionalProperties:false` + numeric
  bounds, registry-derived rate tiers. Also fixed an IPv6-validation bug the
  new tests surfaced.

**Consciously deferred** (low risk; carried for the next review):
- Three transitive advisories (`hono`/`express-rate-limit`/`qs`) held by the
  30-day supply-chain rule — unreachable in this stdio-only server; revisit
  2026-06-15.
- DS-digest hex-redaction scoping, `confirm`-guard / `pickAllowed` de-dup,
  optional durable audit sink, fail-closed token-file permissions,
  `skipLibCheck:false`, tool `title` fields.

## VERDICT: NO-GO ✗

NO-GO is forced by synthesis rule #3: CLAUDE.md violations are always CRITICAL, and package.json carries three caret-range dependency specifiers that violate the user's non-negotiable global pinning rule ("Pin every version exactly. No ranges, no latest, no floating"). This overrides the reviewers' MEDIUM/LOW adjustments — if rule #3 did not escalate these, it would be vacuous, since every pinning finding in the inputs was already downgraded by the adversarial verdicts. The runtime dependency (@modelcontextprotocol/sdk ^1.25.3) is the sharpest case because this is a published, npx-consumable package whose lockfile does not ship to downstream consumers, so the caret floats fresh on every `npm install -g` / `npx`. Independently, a HIGH tool-poisoning exposure (untrusted DNS-derived text returned verbatim to the model while destructive write sinks are registered in the same session — the lethal-trifecta pattern) would by itself mandate CONDITIONAL. With one CRITICAL present, the verdict is NO-GO. Both must be resolved and re-reviewed before merge/publish.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOCKING ISSUES (must fix before merge/publish)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- [CLAUDE.md / Supply-Chain Pinning] package.json:19,22,23 — Three caret (^) range specifiers violate the non-negotiable global exact-pin rule: @modelcontextprotocol/sdk "^1.25.3" (runtime dep, line 19), @types/node "^22.0.0" (line 22), typescript "^5.7.0" (line 23); lockfile has already floated the SDK past its declared floor and does not ship to npx/global consumers of this published package. Fix: pin each to the exact lockfile-resolved version after a 30-day age check + audit, regenerate and commit package-lock.json (Security/The Sentinel)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HIGH (fix before merge — blocks CONDITIONAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- [Tool Poisoning / Prompt Injection] src/sanitize.ts:43 — sanitizeResponse redacts sensitive KEYS and 32+ char hex but never neutralizes injection text in attacker-controlled VALUES; dns_resolve TXT rdata (dns-client.ts:70), dns_query_logs qnames (logs.ts:105), dns_get_stats top* (dashboard.ts:42), cache/zone/BIND export all flow to the model verbatim while destructive write sinks (blocked/allowed add+delete, settings/set, zone delete) are registered in the same session = lethal trifecta. Fix at the trust boundary: fence/label DNS-derived free text as untrusted data in the JSON envelope and/or gate write tools behind confirmation, not in sanitize.ts (MCP/The MCP Developer)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MEDIUM (fix this sprint)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- [Missing I/O Timeout] src/client.ts:33 — every fetch() (authenticate L33, doCall L91, callRawText L126/145, callRawTextGet L177/193) has no AbortSignal/timeout; a TCP-reachable but hung Technitium wedges the tool call indefinitely with no error and no audit record. Fix: wrap each fetch in AbortSignal.timeout(ms) and translate AbortError into a clear timeout error (Reliability/The Skeptic)
- [Error Swallowed] src/client.ts:155 — callRawText (and callRawTextGet L203) treat any JSON.parse SyntaxError as 'raw zone text we want' and return a 502/503 HTML error body verbatim, so dns_export_zone reports HTML as the zone file and dns_list_records' parseBind silently yields zero records. Fix: check resp.ok first; only treat SyntaxError as raw text on a 2xx status (Reliability/The Skeptic)
- [Retry Not Re-Validated] src/client.ts:150 — the invalid-token retry in callRawText (L150) and callRawTextGet (L197) returns retryResp.text() without re-running the JSON.parse/status check, so a second error JSON (zone deleted mid-call, clock-skew race) is masked as zone data. Fix: factor parse-and-validate into a helper and apply it to the retry response (Reliability/The Skeptic)
- [Unvalidated Privileged Config / SSRF] src/tools/settings.ts:83 — dns_set_settings allowlists keys but passes values through String(value) unvalidated, so forwarders (DNS hijack), blockListUrls (server-side SSRF/metadata fetch) and reverseProxyNetworkACL (X-Real-IP trust) reach /api/settings/set unfiltered; validateIpOrHostname (validate.ts:38) also returns any https:// string unchecked into dns_resolve's server param. Fix: validate each comma entry (validateIp/validateDomain/real URL parse rejecting loopback+link-local+RFC1918), add maxLength (Security/The Sentinel)
- [Token in URL Query] src/client.ts:177 — callRawTextGet places the session token in the GET query string (L172-177 and retry L193-196), which proxy/web-server access logs capture in cleartext, unlike the POST body paths; reachable via dns_export_zone / dns_list_records. Fix: send the token in the body (POST) consistently or confirm+document Technitium does not log query strings (Security/The Sentinel)
- [Duplicated Auth-Retry / Fetch Logic] src/client.ts:115 — the null-token/re-auth/re-fetch recovery is implemented 3x (call L72-77, callRawText L137-151, callRawTextGet L185-198) and the URLSearchParams+token fetch block ~5x; callRawText/callRawTextGet are near-identical POST/GET twins, so any retry-behavior change must be made in three places. Fix: extract one private fetchWithToken(method,endpoint,params) owning construction + retry-once (Structure/The Architect — supersedes duplicate Librarian finding)
- [Rate-Limit Classification Drift] src/rate-limit.ts:25 — destructive/mutate tiers are hardcoded string arrays that must stay in sync with tool definition.name values in tools/*.ts; a renamed/new destructive tool silently fails open (no stricter limit, no test, no error). Fix: move the tier onto the ToolEntry/definition and derive limits from registered tools at startup (Structure/The Architect)
- [Large Unbounded Payload] src/tools/dashboard.ts:34 — dns_get_stats returns full topClients/topDomains/topBlockedDomains arrays (hundreds of entries over LastYear) with no size cap, serialized into one MCP response. Fix: slice each top-N list to ~20 before returning, or add a limit param (Performance/The Auditor)
- [Schema/Handler Mismatch] src/tools/records.ts:232 — dns_update_record enum advertises NS/PTR but the handler maps only A/AAAA/CNAME/MX/TXT, so selecting NS/PTR reaches the API with no value param = silent no-op/malformed update. Fix: remove NS/PTR from the enum or add their value mappings (MCP/The MCP Developer)
- [Schema/Handler Mismatch] src/tools/records.ts:300 — dns_delete_record enum advertises SRV/CAA/PTR but the handler maps none of them, so the delete call omits the value it claims to require. Fix: align enum with handler value-mappings or drop the unsupported types (MCP/The MCP Developer)
- [Protocol Conformance] src/tools/settings.ts:88 — dns_set_settings returns JSON.stringify({error:...}) as a normal content block when no keys are supplied; index.ts only sets isError:true on thrown exceptions, so the client sees an error as success. Fix: throw Error('No settings provided') so the central handler marks isError:true (MCP/The MCP Developer)
- [Unguarded Response Shape] src/tools/records.ts:77 — dns_list_records does (zoneList.zones as Array).filter() with no guarantee /api/zones/list returned a zones array; a partial/changed payload throws 'Cannot read properties of undefined'. This path was churned by 3 recent fix commits with no test. Fix: Array.isArray guard + clear error, same for allZones[0] at L93 (Reliability/The Skeptic)
- [Unguarded Response Shape] src/tools/dashboard.ts:68 — dns_get_stats/dns_health_check cast stats sub-objects without guards (s.totalQueries throws if stats omitted) and dns_health_check uses Promise.all so one failing dependency collapses the whole check. Fix: default-guard the casts and use Promise.allSettled for per-dependency degradation reporting (Reliability/The Skeptic)
- [Test Coverage Gap] src/tools/records.ts:6 — parseBind (whitespace split, >=5-field filter, TTL parseInt, FQDN @/dotted special-casing) has zero tests despite 3 recent regression-fix commits; a wrong parse silently returns an incomplete record set to an agent that may then make destructive changes. Fix: add vitest + characterization tests (apex, relative/absolute names, TXT-with-spaces, SOA, malformed TTL) (Reliability/The Skeptic)
- [Test Coverage Gap] src/client.ts:49 — the authInFlight mutex and invalid-token retry are race-prone (token nulled by one in-flight call while another reads sessionToken! at L88) and untested. Fix: mocked-fetch tests for single-login concurrency, mid-flight token invalidation, and null-token assertion sites; consider capturing the token into a local before doCall (Reliability/The Skeptic)
- [Magic Number] src/sanitize.ts:3 — the token-detection hex threshold is a bare literal 20 in sanitizeError vs 32 in sanitizeString (L65), an unexplained 12-char inconsistency between two functions doing the same redaction task. Fix: extract named constants with a rationale comment and reconcile the two values (Readability/The Librarian)
- [Magic Number] src/audit.ts:10 — the 200-char audit truncation limit is a bare literal in the length check and substring. Fix: extract MAX_AUDIT_ARG_LENGTH=200 with a comment (Readability/The Librarian)
- [Magic Number] src/tools/logs.ts:72 — Math.min(Number(entriesPerPage)||25,100) hardcodes default 25 and cap 100 as inline literals with no constant or note on whether 100 is an upstream API limit. Fix: extract DEFAULT/MAX_ENTRIES_PER_PAGE constants (Readability/The Librarian)
- [Magic Number / Silent Clamp] src/tools/settings.ts:145 — Math.min(args.minutes,60) silently caps blocking-disable at 60 with the cap invisible to the caller and absent from the schema. Fix: extract MAX_BLOCKING_DISABLE_MINUTES=60, document it in the schema (Readability/The Librarian)
- [Naming] src/tools/dashboard.ts:68 — single-letter 's' aliases the stats record across the handler (read 6 times), not a lambda param. Fix: rename to hourlyStats/rawStats per the file's own naming style (Readability/The Librarian)
- [Repeated JSON Round-Trip] src/index.ts:85 — every successful response is JSON.parse'd then JSON.stringify'd again for sanitize+pretty-print after the tool already stringified it (3 JSON ops where 1 suffices). Fix: have handlers return objects and sanitize before the single stringify (Performance/The Auditor)
- [Regex Cost] src/sanitize.ts:1 — sanitizeError unconditionally applies all 6 SENSITIVE_PATTERNS (incl. broad path/stack regexes) to every error string, including the per-call audit error path. Fix (low priority): length-gate or combine patterns; not a bottleneck at 100/min (Performance/The Auditor)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOW (optional / next cleanup pass)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- [Performance Micro-Opt] src/rate-limit.ts:86 — pruneTimestamps uses Array.shift() (O(n)) in a while-loop; bounded by the 100/5/10 caps so total cost is linear not quadratic and never on a hot path. Fix (optional): head-pointer index instead of shift (Performance/The Auditor)
- [Sequential Awaits] src/tools/records.ts:107 — multi-zone dns_list_records exports zones in a serial for-of loop; each /api/zones/export is independent. Only the uncommon parent-match branch, typically local single-server. Fix: Promise.allSettled to parallelize (Performance/The Auditor)
- [Resource Bound] src/tools/records.ts:107 — the same multi-zone loop has no cap on zone count or accumulated BIND text; a parent matching hundreds of subzones builds a large in-memory result with no timeout protection. Fix: cap zone count with a truncated:true marker and rely on the per-fetch timeout (Reliability/The Skeptic)
- [Non-JSON / Status Handling] src/client.ts:38 — authenticate (L38) and doCall (L97) call resp.json() with no resp.ok/content-type check, so a 502/503 HTML body surfaces as a confusing 'Unexpected token <' parse error instead of 'HTTP 502'. Fix: check resp.ok and emit a status-bearing message (Reliability/The Skeptic)
- [Error Leak] src/tools/records.ts:114 — the per-zone catch embeds String(e) in a successful response, which goes through sanitizeResponse (key/hex only) not sanitizeError, so a server path / .cs stack frame returns un-redacted unlike the throw path. Fix: error: sanitizeError(String(e)) (Security/The Sentinel)
- [Plaintext HTTP] src/config.ts:21 — TECHNITIUM_ALLOW_HTTP=true disables the HTTPS requirement, sending the admin token/password in cleartext over the URLSearchParams body (warning is emitted, HTTPS is default). Fix: restrict the http:// allowance to loopback (127.0.0.0/8, ::1) (Security/The Sentinel)
- [False-Positive Redaction] src/sanitize.ts:63 — sanitizeString redacts any 32+ char hex run, corrupting legitimate DNSSEC DS digests returned by dns_get_ds (dnssec.ts:52). Fix: scope hex redaction to error messages/known token fields or exclude DNSSEC digest fields (MCP/The MCP Developer)
- [Schema Bounds] src/tools/logs.ts:20 — numeric params (pageNumber, entriesPerPage, ttl, priority, minutes) lack minimum/maximum in their schemas; some are clamped silently in handlers, some not at all. Fix: add min/max so the advertised contract matches handler behavior (MCP/The MCP Developer)
- [Schema Bounds] src/tools/records.ts:156 — record value/text, forwarders/blockListUrls/reverseProxyNetworkACL, zoneTransfer/notify params accept unbounded strings; TXT value passes straight to the API. Fix: add maxLength and enforce via the existing validateStringLength (MCP/The MCP Developer)
- [Schema Strictness] src/types.ts:11 — no inputSchema sets additionalProperties:false, so every tool silently accepts invented params. Fix: add additionalProperties:false to the ToolDefinition type and all schemas (MCP/The MCP Developer)
- [Confirm-Guard Duplication] src/tools/blocking.ts:189 — the confirm!==true warning block is copied across 6 destructive handlers (blocking.ts:189/225, zones.ts:81, records.ts:334, cache.ts:25, apps.ts:94). Fix: extract requireConfirm(args,msg) helper; do not abstract the whole tool shape (Structure/The Architect)
- [Validation Inconsistency] src/tools/records.ts:350 — the record-type-to-API-param switch is repeated 3x and dns_delete_record skips validation for CNAME/MX/NS that dns_add_record enforces. Fix: extract mapRecordValueToParams with one consistent validation policy (Structure/The Architect)
- [Duplication] src/tools/settings.ts:72 — the allowlist filter+String() loop is duplicated between dns_set_settings and dns_set_zone_options (zones.ts:209). Fix: extract pickAllowed(args,allowedKeys) helper (Structure/The Architect)
- [Duplication] src/tools/logs.ts:91 — the responseCode list is duplicated between the schema enum (L53-59) and an inline validation Set (L91-97), drifting by hand. Fix: define once as a module const, reference in both (Structure/The Architect)
- [Permission Mask Clarity] src/config.ts:43 — stat.mode & 0o777 then & 0o077 uses bare octal masks with no comment explaining the group/other-permission check. Fix: add GROUP_OTHER_PERMISSION_MASK constant + comment (Readability/The Librarian)
- [Comment Quality] src/tools/records.ts:25 — parseBind's three-case FQDN ternary (@ apex / absolute FQDN / relative label) has no explanation. Fix: add a comment block or named helper (Readability/The Librarian)
- [Redaction Robustness] src/sanitize.ts:23 — SENSITIVE_KEYS manually enumerates camelCase/snake variants and will miss APIKey/CONNECTION_STRING. Fix: store lowercase canonical forms and compare with key.toLowerCase() (Readability/The Librarian)
- [Engines Range] package.json:16 — engines.node uses >=18.0.0; advisory metadata, not a resolvable dependency, so not a pinning violation but inconsistent with stated intent. Fix (optional): tighten to the tested LTS or document tested versions (Readability/The Librarian)
- [Blocking Startup I/O] src/config.ts:41 — loadConfig uses readFileSync/statSync for the token file; acceptable as a one-time startup cost but blocks on slow/NFS filesystems. Fix (optional): async fs.readFile/stat if startup latency matters (Performance/The Auditor)
- [Allocation] src/client.ts:86 — doCall builds+stringifies URLSearchParams per call and the retry paths reconstruct a second one; minor allocation, mostly a maintainability note subsumed by the fetchWithToken extraction above. Fix: build the body once in a shared helper (Performance/The Auditor)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Critical: 1 | High: 1 | Medium: 22 | Low: 20 — The technitium-mcp server is a coherent, functional MCP DNS-management tool with sensible structure (centralized sanitize/validate/rate-limit/audit boundary modules), but it ships with a CLAUDE.md-violating floating dependency on a published package, a genuine prompt-injection conduit paired with destructive write sinks (lethal trifecta), pervasive missing-timeout/error-swallowing reliability gaps in the HTTP client, schema-versus-handler mismatches in record tools, and zero automated tests on security-critical and recently-regressed code paths; it is not publish-ready until the CRITICAL pinning violation and HIGH injection exposure are resolved and re-reviewed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCAFFOLD-DERIVED IMPROVEMENT BACKLOG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mined from notebooklm-mcp-secure (security modules, the ISSUES-legacy-2026-04-24.md
master list of ~300 closed issue IDs, issues.md, REMEDIATION-PLAN.md, CI/test infra),
each item verified against technitium-mcp's actual code and applicability-checked.
Items overlapping a finding above are merged here as the fix vehicle.

### HIGH priority

1. **Add a `files` whitelist to package.json** (small) — npm pack currently ships
   TODO.md (internal planning notes incl. an auth-scope gap) and the whole src/ tree.
   [infra miner]
2. **Add `prepublishOnly` clean-rebuild script** (small) — publish currently ships
   whatever bytes sit in dist/; src/dist drift has already happened once. [infra miner]
3. **Add CI workflow: build + test + audit on push/PR** (small) — no .github/ at all;
   copy the shape of the scaffold's ci.yml, pin action versions. [infra miner, scaffold .github/]
4. **Minimal vitest setup targeting the security-boundary modules first** (medium) —
   sanitize.ts, validate.ts, rate-limit.ts, audit.ts, then parseBind characterization
   tests and client auth-retry mock tests (covers the four Test Coverage Gap findings
   above). [infra miner + legacy archive I121/I128/I297 class]
5. **Tool annotations on all 27 tools** (medium) — zero `readOnlyHint` /
   `destructiveHint` / `idempotentHint` / `openWorldHint` anywhere; ToolDefinition
   (src/types.ts:8-16) cannot even carry them. Destructive tools (dns_delete_zone,
   dns_delete_record, dns_flush_*, dns_uninstall_app) advertise no destructiveHint;
   dns_resolve/dns_query_logs/dns_check_update need openWorldHint; all dns_list_*/
   dns_get_* need readOnlyHint. [legacy archive I030–I041]

### MEDIUM priority

6. **Schema strictness sweep** (medium) — add `additionalProperties: false` to every
   inputSchema (zero today) and bounds to match handler intent: ttl {min 0, max
   2147483647}, priority {0–65535}, pageNumber {min 1}, entriesPerPage {1–100},
   minutes {1–60}, maxLength on free-text fields. Closes the silent-clamp and
   unbounded-number findings above at the contract layer. [legacy archive I042–I057]
7. **Typed error hierarchy (~4 classes)** (small) — ValidationError / UpstreamError /
   AuthError / RateLimitError instead of bare `new Error` everywhere; lets index.ts
   map error class to response shape instead of treating every throw identically.
   [scaffold src/errors.ts]
8. **Return `structuredContent` alongside the text block** (small) — index.ts:86
   already has the parsed object; SDK ≥1.13 hosts currently get only a stringified
   blob. [legacy archive I010]
9. **Global crash handlers + shutdown flush** (small) — no `uncaughtException` /
   `unhandledRejection` handlers; shutdown calls process.exit without flushing
   in-flight responses. [legacy archive I014]
10. **Runtime arg type-guards at dispatch** (medium) — 57 blind `as string`/`as number`
    casts on args; a wrong-typed arg only fails when a downstream validator happens to
    catch it. Small per-tool parser (Zod or hand-written typeof guards) at the
    index.ts dispatch boundary. [legacy archive I008/I062–I067/I083]
11. **Fence DNS-derived free text as untrusted data** (medium) — the fix vehicle for
    the HIGH tool-poisoning finding above: label/wrap qnames, TXT rdata, top-domains
    etc. as data in the response envelope; pair with the existing confirm:true gates.
    [lessons miner + MCP Developer pillar]
12. **SECURITY.md with private disclosure path** (small) — public package, no
    vulnerability-reporting route. [scaffold SECURITY.md]
13. **CHANGELOG.md + lightweight release checklist + git tags** (medium) — v1.2.4 with
    zero tags and no release trail. [scaffold CHANGELOG.md, .github/RELEASE_CHECKLIST.md]

### LOW priority

14. **Reuse the canonical SENSITIVE_KEYS set in audit.ts** (small) — audit redaction
    covers only password/pass/token/secret; sanitize.ts's broader set isn't applied
    on the audit path. [workflow backlog]
15. **npm publish provenance via tag-triggered workflow** (medium) — trust signal for
    a public package. [infra miner]
16. **Optional durable audit sink for destructive ops** (small) — audit events go to
    stderr only; an env-gated append-to-file sink (TECHNITIUM_AUDIT_FILE) gives a
    forensic trail. Do NOT port hash-chaining. [scaffold audit-logger.ts, descoped]
17. **Fail closed on loose token-file permissions** (small) — config.ts:43-47 warns on
    group/other access but reads the file anyway. [scaffold file-permissions.ts]
18. **Set `skipLibCheck: false`** (small) — currently masks SDK type regressions.
    [legacy archive I311]
19. **Add `title` display names to tool definitions** (small) — cosmetic host-UI
    polish. [legacy archive I041/I079]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPLICITLY REJECTED SCAFFOLD PATTERNS (do not implement)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Each was examined and rejected as disproportionate for a ~2,500-line single-operator
homelab DNS tool on stdio transport:

- **Hash-chained tamper-evident audit log** — defends multi-user/compliance systems;
  threat model absent here.
- **Generic cloud-credential secrets scanner** — DNS API responses have a narrow known
  shape; entropy scanning would false-positive on base64 TXT records and DNSSEC keys.
- **SecureString in-memory scrubbing** — V8 string immutability makes it best-effort
  (the scaffold's own header concedes this); env-var deletion already covers it.
- **Inbound MCP auth + lockout/backoff** — stdio transport: the spawning process IS
  the trust boundary.
- **Session timeout manager / quota manager** — stateless server; these model
  NotebookLM browser sessions and license tiers.
- **Rate-limit bucket-map bounding** — verified: buckets are keyed by a fixed ~21-tool
  set, not user input; the scaffold bounds its map because it keys by session-ID/IP.
- **Post-quantum crypto / GDPR-SOC2 compliance suite** — no encrypted state, no
  personal-data obligations.
- **Response size caps on the Technitium client** — only host contacted is the
  operator's own configured server; speculative robustness.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLEAN BILL — SCAFFOLD LESSONS ALREADY ABSORBED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Checked against the scaffold's closed-issue classes and confirmed already handled:

- `isError: true` correctly set on unknown-tool, rate-limit, and catch paths
- Error sanitization (tokens, credential URLs, paths, stack traces, global regexes)
  routed through sanitizeError on every caught error
- Audit arg redaction on both success and error paths
- Readonly mode filters all write tools; destructive tools additionally gated behind
  `confirm: true`
- Settings/zone-options mass-assignment guarded by explicit key allowlists
- HTTP-without-TLS refused unless explicitly overridden; plaintext warning emitted
- Token-expiry re-auth with in-flight mutex handles concurrent-auth dedupe
- Credential env vars deleted after config load
- 8-layer Pantheon score: Input Validation strong; Credential Protection good;
  Rate Limiting strong for its model; Audit Logging partial (stderr-only);
  Response Validation partial (injection fencing pending — HIGH finding);
  PQ-crypto/Compliance/Inbound-session N/A by design.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROCESS NOTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 27 agents total: 6 reviewers (Sentinel, Architect, Auditor, Librarian, Skeptic,
  MCP Developer), 3 scaffold miners + 1 legacy-archive miner, adversarial verifiers
  on every CRITICAL/HIGH finding, applicability checkers, Lead Developer synthesis.
- 11 CRITICAL/HIGH findings survived adversarial verification; 1 was refuted
  (response-size cap — see rejected list). 39 MEDIUM/LOW pass unverified by design.
- One workflow chain (module-comparison applicability) failed structured output and
  was re-run as a standalone agent; its results are merged above.
- MEDIUM/LOW findings were NOT adversarially verified (cost bound) — treat individual
  line numbers as high-confidence but not guaranteed.
