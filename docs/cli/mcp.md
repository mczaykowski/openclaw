---
summary: "CLI reference for `openclaw mcp` (list/add/remove/start/stop)"
read_when:
  - You want to inspect active MCP servers
  - You want to override or manage MCP servers from config
  - You need to disable/enable a skill-provided MCP server
title: "mcp"
---

# `openclaw mcp`

Manage MCP server overrides used by skill-backed CLI runs.

Related:

- Skills CLI: [Skills CLI](/cli/skills)
- Skills system: [Skills](/tools/skills)

## Commands

```bash
openclaw mcp list
openclaw mcp list --json

openclaw mcp add <name> --command <cmd> [--arg <value> ...] [--env KEY=VALUE ...] [--disabled]
openclaw mcp remove <name>
openclaw mcp start <name>
openclaw mcp stop <name>
```

## Notes

- `mcp list` shows two views:
  - Active servers resolved from skills + overrides.
  - Raw config overrides from `skills.mcpServers`.
- `mcp add` creates or updates a config override for a server name.
- `mcp stop` writes `enabled: false` for the server override.
- `mcp start` re-enables an override (or removes a disable-only override).

## Example

```bash
openclaw mcp add github --command npx --arg @modelcontextprotocol/server-github --env GITHUB_TOKEN=${GITHUB_TOKEN}
openclaw mcp list
openclaw mcp stop github
openclaw mcp start github
```
