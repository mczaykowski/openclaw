import { beforeEach, describe, expect, it, vi } from "vitest";

const startProjectWorkflowMock = vi.fn();
const closeMock = vi.fn(async () => {});
const connectMock = vi.fn(async () => ({
  startProjectWorkflow: startProjectWorkflowMock,
  getProjectWorkflowStatus: vi.fn(),
  getProjectWorkflowResult: vi.fn(),
  pauseProjectWorkflow: vi.fn(),
  resumeProjectWorkflow: vi.fn(),
  cancelProjectWorkflow: vi.fn(),
  close: closeMock,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({
    temporal: {
      enabled: true,
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "openclaw-tasks",
    },
  }),
}));

vi.mock("../../temporal/client/index.js", () => ({
  OpenClawTemporalClient: {
    connect: (...args: unknown[]) => connectMock(...args),
  },
}));

const { createTemporalProjectTool } = await import("./temporal-project-tool.js");

describe("temporal_project finalize_notify guard", () => {
  beforeEach(() => {
    startProjectWorkflowMock.mockReset();
    closeMock.mockClear();
    connectMock.mockClear();
    startProjectWorkflowMock.mockResolvedValue({ workflowId: "wf-1" });
  });

  it("rejects finalize_notify when actorRole is not zed-main", async () => {
    const tool = createTemporalProjectTool();

    await expect(
      tool.execute("call-finalize-invalid", {
        action: "start",
        projectId: "OpenClaw",
        steps: [
          {
            id: "finalize_notify",
            prompt: "Send completion update",
            actorRole: "subagent:zed-coder",
          },
        ],
      }),
    ).rejects.toThrow(/zed-main/i);

    expect(startProjectWorkflowMock).not.toHaveBeenCalled();
  });

  it("allows finalize_notify when actorRole is zed-main", async () => {
    const tool = createTemporalProjectTool();

    const result = await tool.execute("call-finalize-valid", {
      action: "start",
      projectId: "OpenClaw",
      steps: [
        {
          id: "finalize_notify",
          prompt: "Send completion update",
          actorRole: "zed-main",
        },
      ],
    });

    const details = result.details as {
      status?: string;
      workflowId?: string;
    };
    expect(details.status).toBe("started");
    expect(details.workflowId).toBe("wf-1");
    expect(startProjectWorkflowMock).toHaveBeenCalledTimes(1);
  });

  it("allows finalize_notify when agentId defaults to main", async () => {
    const tool = createTemporalProjectTool();

    const result = await tool.execute("call-finalize-main-default", {
      action: "start",
      projectId: "OpenClaw",
      steps: [
        {
          id: "finalize_notify",
          prompt: "Send completion update",
          agentId: "main",
        },
      ],
    });

    const details = result.details as {
      status?: string;
    };
    expect(details.status).toBe("started");
    expect(startProjectWorkflowMock).toHaveBeenCalledTimes(1);
  });
});
