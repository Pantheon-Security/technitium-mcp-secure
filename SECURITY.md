# Security Policy

## Supported Versions

Only the latest published `1.x` release receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.3.x   | ✅         |
| < 1.3   | ❌         |

## Reporting a Vulnerability

Please report security issues privately — do **not** open a public issue for
an exploitable vulnerability.

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" on the Security tab), or
- email the maintainer listed in `package.json`.

Please include a description, affected version, and reproduction steps.
Expect an acknowledgement within **7 days** and a fix or mitigation plan for
confirmed issues within **30 days**.

## Security Model

`technitium-mcp` is a stdio MCP server that proxies the Technitium DNS admin
API. Key properties:

- **Trust boundary** — the stdio transport means the process that spawns the
  server is the trust boundary; there is no inbound network authentication.
- **Credentials** — the admin token/password is read from the environment (or
  a token file) at startup; the source env vars are deleted after load and the
  token travels only in POST request bodies, never in URLs.
- **Untrusted DNS data** — responses containing third-party-controlled text
  (resolved records, query logs, blocklist imports, app-store metadata) are
  fenced as untrusted data before being returned to the model, to resist
  prompt injection.
- **Write protection** — set `TECHNITIUM_READONLY=true` to expose only
  read-only tools. Destructive tools additionally require `confirm: true`.
- **Output hygiene** — tokens, credentials, file paths, and stack traces are
  scrubbed from tool responses and error messages.

## Supply Chain

Dependencies are pinned to exact versions; `package-lock.json` is committed and
reviewed on every change. CI runs `npm audit` on every push and pull request.
