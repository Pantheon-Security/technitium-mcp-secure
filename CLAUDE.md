# technitium-mcp — project instructions

## Supply-chain age threshold: 14 days (project override)

This project uses a **14-day** package-age threshold instead of the global
30-day rule (set 2026-06-11, owner decision, to keep dependencies current).
This override applies **only to this repository**; the global 30-day rule in
`~/.claude/CLAUDE.md` still governs every other project.

**All other supply-chain controls remain in force — nothing else is relaxed:**

- Pin every version exactly (no `^`, `~`, `>=`, `latest`); use `overrides` for
  transitive pins. Lock file committed and reviewed on every change.
- Before any install / version bump: age-check (>=14 days here), then
  `medusa scan` + manual review, then log the decision in the commit.
- The CVE-bypass path (CVSS 9.0+ in an installed package) is unchanged.
- Slopsquatting check on any new package name before install.

When running `/check-pkg-age` for this repo, treat **>=14 days = PASS**.
