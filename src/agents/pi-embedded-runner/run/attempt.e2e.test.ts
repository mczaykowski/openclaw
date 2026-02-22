import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceSkillEntries, type SkillSnapshot } from "../../skills.js";
import { injectHistoryImagesIntoMessages, resolveEmbeddedMcpSkillsSnapshot } from "./attempt.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("injectHistoryImagesIntoMessages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("injects history images and converts string content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "See /tmp/photo.png",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(true);
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    const content = messages[0]?.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("avoids duplicating existing image content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(false);
    const first = messages[0];
    if (!first || !Array.isArray(first.content)) {
      throw new Error("expected array content");
    }
    expect(first.content).toHaveLength(2);
  });

  it("ignores non-user messages and out-of-range indices", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: "noop",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[1, [image]]]));

    expect(didMutate).toBe(false);
    expect(messages[0]?.content).toBe("noop");
  });
});

describe("resolveEmbeddedMcpSkillsSnapshot", () => {
  it("rebuilds workspace snapshot when incoming snapshot has no mcp servers", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "filesystem-mcp");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: filesystem-mcp\ndescription: Filesystem MCP\nmetadata:\n  openclaw:\n    mcpServer:\n      name: filesystem\n      command: npx\n      args:\n        - -y\n        - "@modelcontextprotocol/server-filesystem"\n---\n\n# filesystem-mcp\n`,
      "utf-8",
    );

    const staleSnapshot: SkillSnapshot = {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    };

    const resolved = resolveEmbeddedMcpSkillsSnapshot({
      workspaceDir,
      config: undefined,
      skillsSnapshot: staleSnapshot,
      shouldLoadSkillEntries: false,
      skillEntries: [],
    });

    expect(resolved).not.toBe(staleSnapshot);
    expect(resolved.mcpServers?.map((server) => server.name)).toContain("filesystem");
  });

  it("keeps the incoming snapshot when it already includes mcp servers", async () => {
    const workspaceDir = await makeWorkspace();
    const entries = loadWorkspaceSkillEntries(workspaceDir);
    const snapshotWithMcp: SkillSnapshot = {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      mcpServers: [
        { name: "github", command: "npx", args: ["@modelcontextprotocol/server-github"] },
      ],
      version: 1,
    };

    const resolved = resolveEmbeddedMcpSkillsSnapshot({
      workspaceDir,
      config: undefined,
      skillsSnapshot: snapshotWithMcp,
      shouldLoadSkillEntries: true,
      skillEntries: entries,
    });

    expect(resolved).toBe(snapshotWithMcp);
  });
});
