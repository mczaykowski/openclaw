---
summary: "CLI reference for `openclaw skills` (list/info/check/search/install/import)"
read_when:
  - You want to see which skills are available and ready to run
  - You want to discover and install skills from skills.sh or GitHub
  - You want to import MCP-backed skills safely
title: "skills"
---

# `openclaw skills`

Inspect skills (bundled + workspace + managed overrides), check readiness, search the marketplace, and install/import skills from trusted sources.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- ClawHub installs: [ClawHub](/tools/clawhub)
- MCP server management: [MCP CLI](/cli/mcp)

## Commands

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check

openclaw skills search [query]

openclaw skills install <target> [--skill <name>]
openclaw skills import <source> [--skill <name>]
```

## Marketplace discovery

Use `search` to query the `skills` marketplace (`npx skills find`):

```bash
openclaw skills search github
openclaw skills search "project management"
```

If you omit `query`, the command relies on interactive terminal behavior from `skills find`.

## Install/import from trusted sources

`install` and `import` run `npx skills add` under your agent workspace with guardrails.

Supported source formats:

- `https://skills.sh/<owner>/<repo>/<skill>`
- `https://github.com/<owner>/<repo>`
- `<owner>/<repo>`
- `<owner>/<repo>/<skill>`

If source includes `/.../<skill>`, `--skill` can be omitted.

Examples:

```bash
openclaw skills install https://skills.sh/vercel-labs/skills/find-skills --yes
openclaw skills install vercel-labs/skills/find-skills --yes
openclaw skills import https://github.com/vercel-labs/skills --skill find-skills --yes
```

Trust policy:

- Default trusted repos include `vercel-labs/skills`.
- Add trusted repos with `--trusted-repo <owner/repo>`.
- Bypass trust checks only when intentional with `--allow-untrusted`.

```bash
openclaw skills install https://github.com/acme/private-skills --skill release --trusted-repo acme/private-skills --yes
openclaw skills import https://github.com/acme/private-skills --skill release --allow-untrusted --yes
```

## MCP-backed skills

After install/import, OpenClaw checks whether the skill declares `metadata.openclaw.mcpServer`.
When present, it prints the detected MCP server and that it will be injected automatically into compatible CLI runs when the skill is eligible.

Check merged MCP state with:

```bash
openclaw mcp list
```
