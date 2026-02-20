import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Temporal client so tests stay pure unit (no docker/Temporal server required).
const connectMock = vi.fn(async () => ({ close: vi.fn(async () => {}) }));
const startMock = vi.fn();
const getHandleMock = vi.fn((workflowId: string) => ({ workflowId }));

class WorkflowExecutionAlreadyStartedErrorMock extends Error {
  override name = "WorkflowExecutionAlreadyStartedError";
}

vi.mock("@temporalio/client", () => {
  return {
    Connection: {
      connect: connectMock,
    },
    Client: class {
      workflow = {
        start: startMock,
        getHandle: getHandleMock,
      };
    },
    WorkflowExecutionAlreadyStartedError: WorkflowExecutionAlreadyStartedErrorMock,
  };
});

const { OpenClawTemporalClient } = await import("./index.js");

describe("OpenClawTemporalClient", () => {
  beforeEach(() => {
    connectMock.mockClear();
    startMock.mockReset();
    getHandleMock.mockClear();
  });

  it("uses configured taskQueue when starting workflows", async () => {
    startMock.mockResolvedValue({ ok: true });

    const client = await OpenClawTemporalClient.connect({
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "custom-queue",
    });

    await client.startHeartbeatWorkflow("main", 60_000);

    expect(startMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        taskQueue: "custom-queue",
        workflowId: "heartbeat-main",
      }),
    );
  });

  it("treats WorkflowExecutionAlreadyStartedError as success and returns existing handle", async () => {
    startMock.mockRejectedValue(new WorkflowExecutionAlreadyStartedErrorMock("already started"));

    const client = await OpenClawTemporalClient.connect({ taskQueue: "openclaw-tasks" });

    const handle = await client.startHeartbeatWorkflow("main", 60_000);

    expect(getHandleMock).toHaveBeenCalledWith("heartbeat-main");
    expect(handle).toEqual({ workflowId: "heartbeat-main" });
  });
});
