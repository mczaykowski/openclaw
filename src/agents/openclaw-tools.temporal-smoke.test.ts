import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("temporal_smoke tool", () => {
  it("is registered", () => {
    const cfg = {
      temporal: {
        enabled: true,
      },
    } as unknown as OpenClawConfig;

    const tool = createOpenClawTools({ config: cfg }).find(
      (candidate) => candidate.name === "temporal_smoke",
    );
    expect(tool).toBeDefined();
  });
});
