import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { promptYesNo } from "./prompt.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

const DEFAULT_TRUSTED_SKILL_REPOS = new Set<string>(["vercel-labs/skills"]);
const REPO_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_IMPORT_TIMEOUT_MS = 180000;
const DEFAULT_SEARCH_TIMEOUT_MS = 120000;

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function normalizeRepoSegment(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !REPO_SEGMENT_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeRepoId(ownerRaw: string, repoRaw: string): string | null {
  const owner = normalizeRepoSegment(ownerRaw);
  const repo = normalizeRepoSegment(repoRaw.replace(/\.git$/i, ""));
  if (!owner || !repo) {
    return null;
  }
  return `${owner}/${repo}`.toLowerCase();
}

function resolveRepoAndPartsFromUrl(sourceRaw: string): {
  repoId: string;
  host: string;
  parts: string[];
} | null {
  try {
    const url = new URL(sourceRaw);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    if (
      host === "skills.sh" ||
      host.endsWith(".skills.sh") ||
      host === "github.com" ||
      host.endsWith(".github.com")
    ) {
      const repoId = normalizeRepoId(parts[0] ?? "", parts[1] ?? "");
      if (!repoId) {
        return null;
      }
      return { repoId, host, parts };
    }
  } catch {
    return null;
  }

  return null;
}

/** Resolve owner/repo from a source URL or slug. */
export function resolveSkillSourceRepoId(sourceRaw: string): string | null {
  const source = sourceRaw.trim();
  if (!source) {
    return null;
  }

  const slugMatch = source.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?(?:\.git)?$/,
  );
  if (slugMatch) {
    return normalizeRepoId(slugMatch[1] ?? "", slugMatch[2] ?? "");
  }

  const resolved = resolveRepoAndPartsFromUrl(source);
  return resolved?.repoId ?? null;
}

/** Resolve owner/repo/skill slugs and skills.sh URLs to owner/repo for `skills add`. */
export function resolveSkillsAddSource(sourceRaw: string): string {
  const source = sourceRaw.trim();
  if (!source) {
    return "";
  }

  const slugWithSkillMatch = source.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (slugWithSkillMatch) {
    return `${slugWithSkillMatch[1]}/${slugWithSkillMatch[2]}`;
  }

  const resolved = resolveRepoAndPartsFromUrl(source);
  if (resolved) {
    return resolved.repoId;
  }

  return source;
}

/** Infer skill name from owner/repo/skill or skills.sh owner/repo/skill URL. */
export function resolveSkillNameFromSource(sourceRaw: string): string | null {
  const source = sourceRaw.trim();
  if (!source) {
    return null;
  }

  const slugWithSkillMatch = source.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (slugWithSkillMatch) {
    return slugWithSkillMatch[3] ?? null;
  }

  const resolved = resolveRepoAndPartsFromUrl(source);
  if (!resolved) {
    return null;
  }

  if (
    (resolved.host === "skills.sh" || resolved.host.endsWith(".skills.sh")) &&
    resolved.parts.length >= 3
  ) {
    const skill = resolved.parts[2]?.trim() ?? "";
    if (skill && REPO_SEGMENT_RE.test(skill)) {
      return skill;
    }
  }

  return null;
}

function collectOptionValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (typeof entry === "number" || typeof entry === "boolean") {
          return `${entry}`.trim();
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

export function isTrustedSkillSource(source: string, extraTrustedRepoIds?: string[]): boolean {
  const repoId = resolveSkillSourceRepoId(source);
  if (!repoId) {
    return false;
  }

  if (DEFAULT_TRUSTED_SKILL_REPOS.has(repoId)) {
    return true;
  }

  const extra = (extraTrustedRepoIds ?? [])
    .map((entry) => {
      const parsed = resolveSkillSourceRepoId(entry);
      if (parsed) {
        return parsed;
      }
      const slash = entry.indexOf("/");
      if (slash <= 0 || slash >= entry.length - 1) {
        return null;
      }
      const owner = entry.slice(0, slash);
      const repo = entry.slice(slash + 1);
      return normalizeRepoId(owner, repo);
    })
    .filter((entry): entry is string => Boolean(entry));

  return extra.includes(repoId);
}

function formatCommandFailure(actionLabel: string, result: CommandResult): string {
  const code = typeof result.code === "number" ? `exit ${result.code}` : "unknown exit";
  const text = (result.stderr || result.stdout).trim();
  if (!text) {
    return `${actionLabel} (${code}).`;
  }
  const first =
    text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? text;
  return `${actionLabel} (${code}): ${first}`;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") {
    return fallback;
  }

  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string") {
    value = Number.parseInt(raw, 10);
  } else {
    throw new Error("--timeout-ms must be a positive integer.");
  }

  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  return value;
}

function resolveSkillName(params: { source: string; explicitSkill?: unknown }): string {
  const explicit = typeof params.explicitSkill === "string" ? params.explicitSkill.trim() : "";
  const inferred = explicit ? "" : (resolveSkillNameFromSource(params.source) ?? "");
  const skill = explicit || inferred;
  if (!skill) {
    throw new Error(
      "--skill is required unless source is owner/repo/skill or a skills.sh URL ending in /<skill>.",
    );
  }
  if (/\s/.test(skill)) {
    throw new Error("Skill names cannot contain whitespace.");
  }
  return skill;
}

export function buildSkillsImportArgv(params: {
  source: string;
  skill: string;
  agent: string;
}): string[] {
  return ["npx", "skills", "add", params.source, "--skill", params.skill, "--agent", params.agent];
}

export function buildSkillsSearchArgv(params: { query?: string }): string[] {
  const args = ["npx", "skills", "find"];
  const query = params.query?.trim();
  if (query) {
    args.push(query);
  }
  return args;
}

async function logImportedSkillMcpInfo(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  skillName: string;
}): Promise<void> {
  const { loadWorkspaceSkillEntries } = await import("../agents/skills.js");
  const entries = loadWorkspaceSkillEntries(params.workspaceDir, { config: params.config });
  const skillEntry = entries.find((entry) => entry.skill.name === params.skillName);
  const mcp = skillEntry?.metadata?.mcpServer;
  if (!mcp) {
    return;
  }

  const commandPreview = [mcp.command, ...(mcp.args ?? [])].join(" ").trim();
  defaultRuntime.log(`Detected MCP server "${mcp.name}" in skill "${params.skillName}".`);
  if (commandPreview) {
    defaultRuntime.log(`MCP launch command: ${theme.command(commandPreview)}`);
  }
  defaultRuntime.log(
    `This server will be injected automatically into compatible CLI runs when the skill is eligible.`,
  );
  defaultRuntime.log(`Inspect merged MCP config with ${theme.command("openclaw mcp list")}.`);
}

async function importSkillFromSource(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  sourceInput: string;
  skill?: unknown;
  agent?: unknown;
  trustedRepo?: unknown;
  allowUntrusted?: boolean;
  yes?: boolean;
  timeoutMs?: unknown;
}): Promise<void> {
  const sourceInput = params.sourceInput.trim();
  if (!sourceInput) {
    throw new Error("Source is required.");
  }

  const sourceForAdd = resolveSkillsAddSource(sourceInput);
  const skillName = resolveSkillName({
    source: sourceInput,
    explicitSkill: params.skill,
  });

  const agent =
    typeof params.agent === "string" && params.agent.trim() ? params.agent.trim() : "openclaw";

  const extraTrustedRepos = collectOptionValues(params.trustedRepo);
  const trusted =
    isTrustedSkillSource(sourceInput, extraTrustedRepos) ||
    isTrustedSkillSource(sourceForAdd, extraTrustedRepos);
  if (!params.allowUntrusted && !trusted) {
    const repoId = resolveSkillSourceRepoId(sourceForAdd) ?? resolveSkillSourceRepoId(sourceInput);
    throw new Error(
      repoId
        ? `Refusing untrusted repo "${repoId}". Pass --allow-untrusted or add --trusted-repo ${repoId}.`
        : "Could not validate source repo. Pass --allow-untrusted to continue.",
    );
  }

  if (!params.yes) {
    if (!process.stdin.isTTY) {
      throw new Error("Non-interactive shell detected. Re-run with --yes to confirm import.");
    }
    const confirmed = await promptYesNo(
      `Import skill "${skillName}" from "${sourceInput}" into ${params.workspaceDir}?`,
      false,
    );
    if (!confirmed) {
      defaultRuntime.log("Cancelled.");
      return;
    }
  }

  const timeoutMs = parsePositiveInt(params.timeoutMs, DEFAULT_IMPORT_TIMEOUT_MS);
  const argv = buildSkillsImportArgv({ source: sourceForAdd, skill: skillName, agent });
  const result = await runCommandWithTimeout(argv, { timeoutMs, cwd: params.workspaceDir });
  if (result.code !== 0) {
    throw new Error(formatCommandFailure("Import failed", result));
  }

  defaultRuntime.log(`Imported skill "${skillName}" from ${sourceInput}.`);
  await logImportedSkillMcpInfo({
    config: params.config,
    workspaceDir: params.workspaceDir,
    skillName,
  });
  defaultRuntime.log(`Run ${theme.command("openclaw skills check")} to verify requirements.`);
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`,
    );

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillsList(report, opts));
      });
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillInfo(report, name, opts));
      });
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillsCheck(report, opts));
      });
    });

  skills
    .command("search")
    .description("Search skills via `npx skills find`")
    .argument("[query]", "Optional search query")
    .option(
      "--timeout-ms <ms>",
      "Search command timeout in milliseconds",
      `${DEFAULT_SEARCH_TIMEOUT_MS}`,
    )
    .action(async (query, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const queryValue = typeof query === "string" ? query.trim() : "";

        if (!queryValue && !process.stdin.isTTY) {
          throw new Error(
            "Non-interactive shell detected. Provide a query (e.g. `openclaw skills search github`) or run in an interactive terminal.",
          );
        }

        const timeoutMs = parsePositiveInt(opts.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
        const argv = buildSkillsSearchArgv({ query: queryValue });
        const result = await runCommandWithTimeout(argv, { timeoutMs, cwd: workspaceDir });
        if (result.code !== 0) {
          throw new Error(formatCommandFailure("Search failed", result));
        }

        const output = [result.stdout.trim(), result.stderr.trim()]
          .filter(Boolean)
          .join("\n")
          .trim();
        defaultRuntime.log(output || "No search output.");
      });
    });

  skills
    .command("install")
    .description("Install a skill from skills.sh/GitHub/owner-repo references")
    .argument("<target>", "skills.sh URL, GitHub URL, owner/repo, or owner/repo/skill")
    .option(
      "--skill <name>",
      "Skill name to install (optional when target already includes /skill)",
    )
    .option("--agent <name>", "Target agent for npx skills add", "openclaw")
    .option(
      "--trusted-repo <owner/repo>",
      "Additional trusted repo (repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option("--allow-untrusted", "Allow installing from non-trusted sources", false)
    .option("--yes", "Skip confirmation prompt", false)
    .option(
      "--timeout-ms <ms>",
      "Install command timeout in milliseconds",
      `${DEFAULT_IMPORT_TIMEOUT_MS}`,
    )
    .action(async (target, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));

        await importSkillFromSource({
          config,
          workspaceDir,
          sourceInput: String(target ?? ""),
          skill: opts.skill,
          agent: opts.agent,
          trustedRepo: opts.trustedRepo,
          allowUntrusted: Boolean(opts.allowUntrusted),
          yes: Boolean(opts.yes),
          timeoutMs: opts.timeoutMs,
        });
      });
    });

  skills
    .command("import")
    .description("Import a skill via `npx skills add` from trusted sources")
    .argument("<source>", "skills.sh URL, GitHub URL, owner/repo, or owner/repo/skill")
    .option("--skill <name>", "Skill name to import (optional when source already includes /skill)")
    .option("--agent <name>", "Target agent for npx skills add", "openclaw")
    .option(
      "--trusted-repo <owner/repo>",
      "Additional trusted repo (repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option("--allow-untrusted", "Allow importing from non-trusted sources", false)
    .option("--yes", "Skip confirmation prompt", false)
    .option(
      "--timeout-ms <ms>",
      "Import command timeout in milliseconds",
      `${DEFAULT_IMPORT_TIMEOUT_MS}`,
    )
    .action(async (source, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));

        await importSkillFromSource({
          config,
          workspaceDir,
          sourceInput: String(source ?? ""),
          skill: opts.skill,
          agent: opts.agent,
          trustedRepo: opts.trustedRepo,
          allowUntrusted: Boolean(opts.allowUntrusted),
          yes: Boolean(opts.yes),
          timeoutMs: opts.timeoutMs,
        });
      });
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const config = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
      const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
      const report = buildWorkspaceSkillStatus(workspaceDir, { config });
      defaultRuntime.log(formatSkillsList(report, {}));
    });
  });
}
