import { describe, expect, it } from "vitest";
import {
  buildSkillsImportArgv,
  isTrustedSkillSource,
  resolveSkillSourceRepoId,
} from "./skills-cli.js";

describe("skills-cli import source parsing", () => {
  it("resolves skills.sh and github sources to owner/repo", () => {
    expect(resolveSkillSourceRepoId("https://skills.sh/vercel-labs/skills/find-skills")).toBe(
      "vercel-labs/skills",
    );
    expect(resolveSkillSourceRepoId("https://github.com/vercel-labs/skills")).toBe(
      "vercel-labs/skills",
    );
    expect(resolveSkillSourceRepoId("vercel-labs/skills")).toBe("vercel-labs/skills");
  });

  it("rejects malformed sources", () => {
    expect(resolveSkillSourceRepoId("https://skills.sh/vercel-labs")).toBeNull();
    expect(resolveSkillSourceRepoId("not a source")).toBeNull();
  });

  it("trusts vercel-labs/skills by default", () => {
    expect(isTrustedSkillSource("https://skills.sh/vercel-labs/skills/find-skills")).toBe(true);
    expect(isTrustedSkillSource("https://github.com/acme/private-skills")).toBe(false);
  });

  it("supports extra trusted repos", () => {
    expect(
      isTrustedSkillSource("https://github.com/acme/private-skills", ["acme/private-skills"]),
    ).toBe(true);
  });
});

describe("skills-cli import argv", () => {
  it("builds npx skills add command", () => {
    expect(
      buildSkillsImportArgv({
        source: "https://github.com/vercel-labs/skills",
        skill: "find-skills",
        agent: "openclaw",
      }),
    ).toEqual([
      "npx",
      "skills",
      "add",
      "https://github.com/vercel-labs/skills",
      "--skill",
      "find-skills",
      "--agent",
      "openclaw",
    ]);
  });
});
