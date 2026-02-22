import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
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

/** Resolve owner/repo from a source URL or slug. */
export function resolveSkillSourceRepoId(sourceRaw: string): string | null {
  const source = sourceRaw.trim();
  if (!source) {
    return null;
  }

  const slugMatch = source.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (slugMatch) {
    return normalizeRepoId(slugMatch[1] ?? "", slugMatch[2] ?? "");
  }

  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    if (host === "skills.sh" || host.endsWith(".skills.sh")) {
      const owner = parts[0] ?? "";
      const repo = parts[1] ?? "";
      return normalizeRepoId(owner, repo);
    }

    if (host === "github.com" || host.endsWith(".github.com")) {
      const owner = parts[0] ?? "";
      const repo = parts[1] ?? "";
      return normalizeRepoId(owner, repo);
    }
  } catch {
    return null;
  }

  return null;
}

function collectOptionValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
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

function formatImportFailure(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): string {
  const code = typeof result.code === "number" ? `exit ${result.code}` : "unknown exit";
  const text = (result.stderr || result.stdout).trim();
  if (!text) {
    return `Import failed (${code}).`;
  }
  const first =
    text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? text;
  return `Import failed (${code}): ${first}`;
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

export function buildSkillsImportArgv(params: {
  source: string;
  skill: string;
  agent: string;
}): string[] {
  return ["npx", "skills", "add", params.source, "--skill", params.skill, "--agent", params.agent];
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
    .command("import")
    .description("Import a skill via `npx skills add` from trusted sources")
    .argument("<source>", "skills.sh URL, GitHub URL, or owner/repo")
    .requiredOption("--skill <name>", "Skill name to import from the source repo")
    .option("--agent <name>", "Target agent for npx skills add", "openclaw")
    .option(
      "--trusted-repo <owner/repo>",
      "Additional trusted repo (repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option("--allow-untrusted", "Allow importing from non-trusted sources", false)
    .option("--yes", "Skip confirmation prompt", false)
    .option("--timeout-ms <ms>", "Import command timeout in milliseconds", "180000")
    .action(async (source, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));

        const sourceValue = String(source ?? "").trim();
        const skill = String(opts.skill ?? "").trim();
        const agent = String(opts.agent ?? "openclaw").trim() || "openclaw";
        if (!sourceValue) {
          throw new Error("Source is required.");
        }
        if (!skill) {
          throw new Error("--skill is required.");
        }

        const extraTrustedRepos = collectOptionValues(opts.trustedRepo);
        const trusted = isTrustedSkillSource(sourceValue, extraTrustedRepos);
        if (!opts.allowUntrusted && !trusted) {
          const repoId = resolveSkillSourceRepoId(sourceValue);
          throw new Error(
            repoId
              ? `Refusing untrusted repo "${repoId}". Pass --allow-untrusted or add --trusted-repo ${repoId}.`
              : "Could not validate source repo. Pass --allow-untrusted to continue.",
          );
        }

        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            throw new Error("Non-interactive shell detected. Re-run with --yes to confirm import.");
          }
          const confirmed = await promptYesNo(
            `Import skill "${skill}" from "${sourceValue}" into ${workspaceDir}?`,
            false,
          );
          if (!confirmed) {
            defaultRuntime.log("Cancelled.");
            return;
          }
        }

        const timeoutMs = parsePositiveInt(opts.timeoutMs, 180000);
        const argv = buildSkillsImportArgv({ source: sourceValue, skill, agent });
        const result = await runCommandWithTimeout(argv, { timeoutMs, cwd: workspaceDir });
        if (result.code !== 0) {
          throw new Error(formatImportFailure(result));
        }

        defaultRuntime.log(`Imported skill "${skill}" from ${sourceValue}.`);
        defaultRuntime.log(`Run ${theme.command("openclaw skills check")} to verify requirements.`);
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
