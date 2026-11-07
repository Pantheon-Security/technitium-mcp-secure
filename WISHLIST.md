# Technitium MCP — wishlist

Written 2026-08-28, derived from a real incident: a payment screen failing in the
Next app. Diagnosis took roughly two hours and **every delay was a missing tool**,
not a hard problem. Each item below is justified by something that actually went
wrong, so priority is by pain caused, not by neatness.

---

## P0 — the three that cost the most

### 1. Multi-server support (the biggest gap by far)

The MCP is hardwired to **dns01**. dns02 exists specifically so the two are
interchangeable — but the MCP can only see one of them, so every dns02 change
today was a bespoke Python script uploaded over SSH and run against
`http://[::1]:5380`. That is slow, unrepeatable, and it silently invited the
divergence in item 2.

    server: "dns01" | "dns02" | "all"      # optional param on EVERY tool

- Default `all` for write actions. A change applied to one resolver but not the
  other is a bug in every case we have hit.
- Per-server endpoints differ and must be config, not assumption:
  dns01 = `https://127.0.0.1:53443`, dns02 = `http://[::1]:5380` (no TLS
  listener, and `127.0.0.1` times out — IPv6 loopback only).

### 2. `dns_compare_servers` — diff dns01 against dns02

**This is the tool that would have saved the whole incident.** dns01 and dns02
were answering the same names differently for hours and nothing surfaced it.

Compare and report differences in: blocklist URLs, allowed/blocked zones,
installed apps, app configs, forwarders, blocking mode, zone SOA serials.
Optionally take a list of domains and report any whose verdict differs.

Should be safe to run on a schedule and alert on drift.

### 3. App config WRITE — `dns_set_app_config`

`dns_get_app_config` exists; there is no setter. The actual fix today —
adding 14 domains to the Advanced Blocking app's `default` group `allowed`
array — had to be done by SSHing to dns01 and POSTing to
`/api/apps/config/set` from a hand-written script.

Nicer than raw JSON, since the config is deeply nested:

    dns_app_group_allow(app, group, domains[])
    dns_app_group_block(app, group, domains[])
    dns_app_list_groups(app)          # names, client subnets, list counts

---

## P1 — would have prevented wrong conclusions

### 4. `dns_allow_domain` must cover BOTH engines

The single most damaging bug of the day. dns01 runs **two independent blocking
engines**:

1. built-in `blockListUrls` + `allowed` zones
2. the **Advanced Blocking app**, with its own per-group `allowed` array

`dns_allow_domain` writes only to (1). The app overrides it. So PayPal, Find My
Device, the checkout fraud check and Safe Browsing were **reported fixed and
verified while still blocked** — verification passed only because it hit cached
answers.

`dns_allow_domain` should write to every engine present, or explicitly return
which engines it did and did not cover. Silent partial success is worse than an
error.

### 5. `dns_query_logs` — filter by blocked, and by time

Today's only route to "what is being blocked for this client" was dumping 100
entries and reading them by eye, or hand-writing SQL against `querylogs.db`.

    responseType: "Blocked"        # server-side filter
    since / until                  # time window, not just paging
    qnameContains                  # substring, not just exact match
    excludeQname[]                 # drop the ad noise to see what matters

⚠️ **The SQL fallback is a trap.** `dns_logs.response_type` is a TINYINT and
**3 is NOT "Blocked"**. Filtering on `response_type = 3` returned
`www.google.com` and every `next.co.uk` name and produced a completely wrong
"Next is blocked" conclusion. Measured over 2h: type 3 = 7254 rows, none of
which answered the block IP; type 4 = 980 rows, 697 of which did. If querying
raw, filter on `answer LIKE '%10.0.10.200%'`. The MCP returns `responseType` as
a proper string — which is exactly why the MCP should be the only path.

### 6. `dns_why_blocked(domain)` — one call, full verdict

Currently requires a `dig TXT`, then reading `source=` to tell
`block-list-zone` (built-in) from `advanced-blocking-app`, then grepping the
blocklist files on disk to find which list carries the entry.

Return: blocked yes/no, **which engine**, which group, which list URL, and
whether an allow entry exists in each engine. Run it against both servers.

---

## P2 — real friction, lower cost

### 7. `dns_resolve_upstream(domain)` — bypass local blocking

To identify who owns a domain you must resolve it *around* your own blocking.
`smetrics.marksandspencer.com` needed a hand-rolled DoH query
(curl + dnspython wire format) because it is blocked locally and the UCGF
firewall correctly blocks direct external DNS. It turned out to be Adobe
(`CNAME → marksandspencer.com.ssl.d3.sc.omtrdc.net`), which settled the
question — but only after real effort.

Should follow the full CNAME chain and show it, since CNAME cloaking is how
first-party-looking analytics hides.

### 8. Cache flush by domain

`dns_flush_cache` is all-or-nothing. After an allowlist change you only need one
name. Flushing the entire cache on a live resolver to test one domain is
heavy-handed — and forgetting to flush is what made stale answers look like
successful fixes.

    dns_flush_domain(domain, server="all")

### 9. Blocking state, explicitly

`dns_temp_disable_blocking` has no cancel and no status. Re-enabling was a guess
(`minutes=0`, which does work). Also: **temporary disable does NOT stop the
Advanced Blocking app** — dns01 kept blocking with built-in blocking off, which
is how the second engine was finally discovered.

    dns_blocking_status()     # per engine, per server, incl. any active timer
    dns_enable_blocking()     # explicit cancel

### 10. Bulk allow/remove

Allowing 14 domains was 14 separate calls on dns01 and a script on dns02.
Take an array. Same for `dns_remove_allowed` — worth having when an allowlist
entry turns out to be wrong (`techlab-cdn.com` was allowed today **without ever
identifying its owner**, purely because it loaded alongside the payment stack —
that needs to be easy to reverse).

---

## Cross-cutting

- **Write actions should verify.** Every "success" today was reported by the
  API and then turned out to be partial. A write tool should re-read and confirm
  the change is live on every server it claims to have changed.
- **Never trust a cached answer as verification.** Post-change checks must flush
  the specific name first, or state plainly that the result may be cached. This
  single behaviour caused every false "fixed" claim in this incident.
- **`iproyal.com` note**: the Advanced Blocking `default` group had exactly one
  allowed entry before today. Whatever the tooling does, it must not clobber
  hand-added entries — merge, never replace.

## Architectural question for the MCP chat

The Advanced Blocking app's `default` group duplicates almost the same lists as
the built-in engine (hagezi adblock/pro, tracking-ags, oisd, SmartTV-AGH,
WindowsSpyBlocker). Its genuinely unique value is the **`guest-kids` group**
(10.0.50.0/24, NSFW + VPN + torrent regex blocking), which the built-in engine
cannot express.

Worth deciding: keep the app **only** for `guest-kids` and let the built-in
engine govern `10.0.0.0/8`? That would collapse two allowlists into one, make
dns01 and dns02 behave identically, and remove the entire class of bug that
caused this incident. Needs a proper look before acting.
