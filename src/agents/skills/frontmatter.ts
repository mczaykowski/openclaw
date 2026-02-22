import type { Skill } from "@mariozechner/pi-coding-agent";
import type {
  MCPSkillServerConfig,
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
} from "./types.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import {
  getFrontmatterString,
  normalizeStringList,
  parseFrontmatterBool,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestInstall,
  resolveOpenClawManifestOs,
  resolveOpenClawManifestRequires,
} from "../../shared/frontmatter.js";

export function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = kindRaw.trim().toLowerCase();
  if (kind !== "brew" && kind !== "node" && kind !== "go" && kind !== "uv" && kind !== "download") {
    return undefined;
  }

  const spec: SkillInstallSpec = {
    kind: kind,
  };

  if (typeof raw.id === "string") {
    spec.id = raw.id;
  }
  if (typeof raw.label === "string") {
    spec.label = raw.label;
  }
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) {
    spec.bins = bins;
  }
  const osList = normalizeStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  if (typeof raw.formula === "string") {
    spec.formula = raw.formula;
  }
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.module === "string") {
    spec.module = raw.module;
  }
  if (typeof raw.url === "string") {
    spec.url = raw.url;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }

  return spec;
}

function parseMcpServerSpec(input: unknown): MCPSkillServerConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!name || !command) {
    return undefined;
  }

  const args = normalizeStringList(raw.args);
  const envRaw = raw.env;
  let env: Record<string, string> | undefined;
  if (envRaw && typeof envRaw === "object" && !Array.isArray(envRaw)) {
    const envEntries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
      const normalizedKey = key.trim();
      if (!normalizedKey || typeof value !== "string") {
        continue;
      }
      envEntries.push([normalizedKey, value]);
    }
    if (envEntries.length > 0) {
      env = Object.fromEntries(envEntries);
    }
  }

  return {
    name,
    command,
    args: args.length > 0 ? args : undefined,
    env,
  };
}

export function resolveOpenClawMetadata(
  frontmatter: ParsedSkillFrontmatter,
): OpenClawSkillMetadata | undefined {
  const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const mcpServer = parseMcpServerSpec(metadataObj.mcpServer ?? metadataObj.mcp_server);
  const requires = resolveOpenClawManifestRequires(metadataObj);
  const install = resolveOpenClawManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveOpenClawManifestOs(metadataObj);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : undefined,
    homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : undefined,
    skillKey: typeof metadataObj.skillKey === "string" ? metadataObj.skillKey : undefined,
    primaryEnv: typeof metadataObj.primaryEnv === "string" ? metadataObj.primaryEnv : undefined,
    os: osRaw.length > 0 ? osRaw : undefined,
    requires: requires,
    install: install.length > 0 ? install : undefined,
    mcpServer,
  };
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterString(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterString(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.metadata?.skillKey ?? skill.name;
}
