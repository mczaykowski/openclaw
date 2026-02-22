import { describe, expect, it } from "vitest";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "./frontmatter.js";

describe("resolveSkillInvocationPolicy", () => {
  it("defaults to enabled behaviors", () => {
    const policy = resolveSkillInvocationPolicy({});
    expect(policy.userInvocable).toBe(true);
    expect(policy.disableModelInvocation).toBe(false);
  });

  it("parses frontmatter boolean strings", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": "no",
      "disable-model-invocation": "yes",
    });
    expect(policy.userInvocable).toBe(false);
    expect(policy.disableModelInvocation).toBe(true);
  });
});

describe("resolveOpenClawMetadata", () => {
  it("parses MCP server metadata", () => {
    const metadata = resolveOpenClawMetadata({
      metadata: `
{
  openclaw: {
    mcpServer: {
      name: "github",
      command: "npx",
      args: ["@modelcontextprotocol/server-github"],
      env: {
        GITHUB_TOKEN: "\${GITHUB_TOKEN}",
        INVALID_NUMBER: 1
      }
    }
  }
}
      `,
    });

    expect(metadata?.mcpServer).toEqual({
      name: "github",
      command: "npx",
      args: ["@modelcontextprotocol/server-github"],
      env: {
        GITHUB_TOKEN: "${GITHUB_TOKEN}",
      },
    });
  });
});
