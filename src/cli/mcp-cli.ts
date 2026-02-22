import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildWorkspaceSkillSnapshot } from "../agents/skills.js";
import {
  type OpenClawConfig,
  loadConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";

type CliMcpServerConfig = {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

function normalizeMcpName(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("MCP server name cannot be empty.");
  }
  return value;
}

function collectRepeatedOption(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function parseEnvOptions(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const idx = entry.indexOf("=");
    if (idx <= 0) {
      throw new Error(`Invalid --env value "${entry}". Use KEY=VALUE.`);
    }
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1);
    if (!key) {
      throw new Error(`Invalid --env value "${entry}". Empty key.`);
    }
    env[key] = value;
  }
  return env;
}

function resolveMcpConfigMap(cfg: OpenClawConfig): Record<string, CliMcpServerConfig> {
  return { ...cfg.skills?.mcpServers };
}

function applyMcpConfigMap(
  cfg: OpenClawConfig,
  mcpServers: Record<string, CliMcpServerConfig>,
): OpenClawConfig {
  const hasEntries = Object.keys(mcpServers).length > 0;
  const nextSkills = {
    ...cfg.skills,
    ...(hasEntries ? { mcpServers } : {}),
  };
  if (!hasEntries) {
    delete (nextSkills as { mcpServers?: Record<string, CliMcpServerConfig> }).mcpServers;
  }
  return {
    ...cfg,
    ...(Object.keys(nextSkills).length > 0 ? { skills: nextSkills } : {}),
  };
}

function resolveWorkspaceDir(cfg: OpenClawConfig): string {
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function resolveResolvedServers(cfg: OpenClawConfig): Array<{
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}> {
  const workspaceDir = resolveWorkspaceDir(cfg);
  const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, { config: cfg });
  return snapshot.mcpServers ?? [];
}

async function updateConfig(
  mutator: (cfg: OpenClawConfig) => OpenClawConfig,
): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = snapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }
  const next = mutator(snapshot.config);
  await writeConfigFile(next);
  return next;
}

function formatMcpListOutput(params: { cfg: OpenClawConfig; json?: boolean }): string {
  const resolved = resolveResolvedServers(params.cfg);
  const overrides = Object.entries(resolveMcpConfigMap(params.cfg))
    .map(([name, value]) => ({
      name,
      enabled: value.enabled,
      command: value.command,
      args: value.args,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  if (params.json) {
    return JSON.stringify(
      {
        workspaceDir: resolveWorkspaceDir(params.cfg),
        active: resolved,
        overrides,
      },
      null,
      2,
    );
  }

  if (resolved.length === 0 && overrides.length === 0) {
    return "No MCP servers configured. Add one with `openclaw mcp add <name> --command <cmd>`.";
  }

  const width = Math.max(70, (process.stdout.columns ?? 120) - 1);
  const lines: string[] = [];

  lines.push(`${theme.heading("Active MCP Servers")} ${theme.muted(`(${resolved.length})`)}`);
  if (resolved.length === 0) {
    lines.push(theme.muted("None"));
  } else {
    lines.push(
      renderTable({
        width,
        columns: [
          { key: "Name", header: "Name", minWidth: 16 },
          { key: "Command", header: "Command", minWidth: 22, flex: true },
          { key: "Args", header: "Args", minWidth: 20, flex: true },
        ],
        rows: resolved.map((server) => ({
          Name: theme.command(server.name),
          Command: server.command,
          Args: (server.args ?? []).join(" "),
        })),
      }).trimEnd(),
    );
  }

  lines.push("");
  lines.push(`${theme.heading("Config Overrides")} ${theme.muted(`(${overrides.length})`)}`);
  if (overrides.length === 0) {
    lines.push(theme.muted("None"));
  } else {
    lines.push(
      renderTable({
        width,
        columns: [
          { key: "Name", header: "Name", minWidth: 16 },
          { key: "Enabled", header: "Enabled", minWidth: 10 },
          { key: "Command", header: "Command", minWidth: 22, flex: true },
          { key: "Args", header: "Args", minWidth: 20, flex: true },
        ],
        rows: overrides.map((entry) => ({
          Name: theme.command(entry.name),
          Enabled:
            entry.enabled === false
              ? theme.warn("false")
              : entry.enabled === true
                ? "true"
                : "(default)",
          Command: entry.command ?? theme.muted("(inherit)"),
          Args: (entry.args ?? []).join(" "),
        })),
      }).trimEnd(),
    );
  }

  return lines.join("\n");
}

export function registerMcpCli(program: Command) {
  const mcp = program
    .command("mcp")
    .description("Manage MCP servers for skill-backed CLI runs")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/mcp", "docs.openclaw.ai/cli/mcp")}\n`,
    );

  mcp
    .command("list")
    .description("List active MCP servers and config overrides")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        defaultRuntime.log(formatMcpListOutput({ cfg, json: Boolean(opts.json) }));
      });
    });

  mcp
    .command("add")
    .description("Add or update an MCP server override")
    .argument("<name>", "MCP server name")
    .requiredOption("-c, --command <command>", "Command to launch the MCP server")
    .option(
      "--arg <value>",
      "Repeatable server arg",
      (value, prev: string[] = []) => [...prev, value],
      [],
    )
    .option(
      "--env <key=value>",
      "Repeatable env var",
      (value, prev: string[] = []) => [...prev, value],
      [],
    )
    .option("--disabled", "Create the entry in disabled state", false)
    .action(async (rawName, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const name = normalizeMcpName(String(rawName));
        const command = String(opts.command ?? "").trim();
        if (!command) {
          throw new Error("Missing --command.");
        }
        const args = collectRepeatedOption(opts.arg);
        const env = parseEnvOptions(collectRepeatedOption(opts.env));

        await updateConfig((cfg) => {
          const mcpServers = resolveMcpConfigMap(cfg);
          mcpServers[name] = {
            enabled: !opts.disabled,
            command,
            ...(args.length > 0 ? { args } : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
          };
          return applyMcpConfigMap(cfg, mcpServers);
        });

        logConfigUpdated(defaultRuntime);
        defaultRuntime.log(
          `MCP server "${name}" ${opts.disabled ? "saved as disabled" : "saved and enabled"}.`,
        );
      });
    });

  mcp
    .command("remove")
    .description("Remove an MCP server override")
    .argument("<name>", "MCP server name")
    .action(async (rawName) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const name = normalizeMcpName(String(rawName));
        await updateConfig((cfg) => {
          const mcpServers = resolveMcpConfigMap(cfg);
          if (!mcpServers[name]) {
            throw new Error(`No MCP override exists for "${name}".`);
          }
          delete mcpServers[name];
          return applyMcpConfigMap(cfg, mcpServers);
        });

        logConfigUpdated(defaultRuntime);
        defaultRuntime.log(`Removed MCP override "${name}".`);
      });
    });

  mcp
    .command("start")
    .description("Enable an MCP server override")
    .argument("<name>", "MCP server name")
    .action(async (rawName) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const name = normalizeMcpName(String(rawName));
        const cfg = loadConfig();
        const existing = resolveMcpConfigMap(cfg)[name];
        if (!existing) {
          const active = resolveResolvedServers(cfg).some((server) => server.name === name);
          if (active) {
            defaultRuntime.log(`MCP server "${name}" is already active.`);
            return;
          }
          throw new Error(`No MCP override exists for "${name}".`);
        }

        await updateConfig((nextCfg) => {
          const mcpServers = resolveMcpConfigMap(nextCfg);
          const current = mcpServers[name];
          if (!current) {
            return nextCfg;
          }
          const isDisableOnlyOverride =
            current.enabled === false &&
            !current.command &&
            (!current.args || current.args.length === 0) &&
            (!current.env || Object.keys(current.env).length === 0);
          if (isDisableOnlyOverride) {
            delete mcpServers[name];
          } else {
            mcpServers[name] = { ...current, enabled: true };
          }
          return applyMcpConfigMap(nextCfg, mcpServers);
        });

        logConfigUpdated(defaultRuntime);
        defaultRuntime.log(`Enabled MCP server "${name}".`);
      });
    });

  mcp
    .command("stop")
    .description("Disable an MCP server by name")
    .argument("<name>", "MCP server name")
    .action(async (rawName) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const name = normalizeMcpName(String(rawName));
        await updateConfig((cfg) => {
          const mcpServers = resolveMcpConfigMap(cfg);
          mcpServers[name] = {
            ...mcpServers[name],
            enabled: false,
          };
          return applyMcpConfigMap(cfg, mcpServers);
        });

        logConfigUpdated(defaultRuntime);
        defaultRuntime.log(`Disabled MCP server "${name}".`);
      });
    });

  mcp.action(async () => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const cfg = loadConfig();
      defaultRuntime.log(formatMcpListOutput({ cfg }));
    });
  });
}
