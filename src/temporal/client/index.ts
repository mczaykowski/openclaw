import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  agentHeartbeatWorkflow,
  temporalProjectCancelSignal,
  temporalProjectPauseSignal,
  temporalProjectResumeSignal,
  temporalProjectStatusQuery,
  temporalProjectWorkflow,
  type TemporalProjectResult,
  type TemporalProjectState,
  type TemporalProjectStepInput,
} from "../workflows/index.js";

const log = createSubsystemLogger("temporal/client");

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return "project";
  }
  return normalized.slice(0, 48);
}

export type TemporalClientOptions = {
  address?: string;
  namespace?: string;
  taskQueue?: string;
};

function isWorkflowAlreadyStartedError(error: unknown): boolean {
  return (
    error instanceof WorkflowExecutionAlreadyStartedError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "WorkflowExecutionAlreadyStartedError")
  );
}

function isWorkflowNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "WorkflowNotFoundError"
  );
}

/**
 * A client that can interact with the Temporal cluster to start and manage OpenClaw workflows.
 */
export class OpenClawTemporalClient {
  private client: Client;
  private connection: Connection;
  private taskQueue: string;

  private constructor(client: Client, connection: Connection, taskQueue: string) {
    this.client = client;
    this.connection = connection;
    this.taskQueue = taskQueue;
  }

  static async connect(opts: TemporalClientOptions = {}) {
    const address = opts.address ?? "127.0.0.1:7233";
    const namespace = opts.namespace ?? "default";
    const taskQueue = opts.taskQueue ?? "openclaw-tasks";

    log.info("Connecting to Temporal Cluster", { address, namespace, taskQueue });

    try {
      const connection = await Connection.connect({ address });
      const client = new Client({ connection, namespace });
      return new OpenClawTemporalClient(client, connection, taskQueue);
    } catch (error) {
      log.error("Failed to connect to Temporal", { error: String(error) });
      throw error;
    }
  }

  /**
   * Starts a durable heartbeat workflow for a specific agent.
   */
  async startHeartbeatWorkflow(agentId: string, intervalMs: number) {
    const workflowId = `heartbeat-${agentId}`;
    log.info("Starting heartbeat workflow", { agentId, workflowId });

    try {
      const handle = await this.client.workflow.start(agentHeartbeatWorkflow, {
        taskQueue: this.taskQueue,
        workflowId,
        args: [agentId, intervalMs],
      });
      return handle;
    } catch (error) {
      if (isWorkflowAlreadyStartedError(error)) {
        log.info("Heartbeat workflow already running; using existing handle", {
          agentId,
          workflowId,
        });
        return this.client.workflow.getHandle(workflowId);
      }
      log.error("Failed to start heartbeat workflow", { agentId, error: String(error) });
      throw error;
    }
  }

  async startProjectWorkflow(params: {
    projectId: string;
    steps: TemporalProjectStepInput[];
    continueOnError?: boolean;
    workflowId?: string;
  }) {
    const projectId = params.projectId.trim();
    const workflowId =
      params.workflowId?.trim() || `project-${slugify(projectId)}-${Date.now().toString(36)}`;

    log.info("Starting temporal project workflow", {
      workflowId,
      projectId,
      steps: params.steps.length,
      continueOnError: params.continueOnError ?? false,
    });

    try {
      return await this.client.workflow.start(temporalProjectWorkflow, {
        taskQueue: this.taskQueue,
        workflowId,
        args: [
          {
            projectId,
            steps: params.steps,
            continueOnError: params.continueOnError,
          },
        ],
      });
    } catch (error) {
      if (isWorkflowAlreadyStartedError(error)) {
        log.info("Project workflow already running; using existing handle", { workflowId });
        return this.client.workflow.getHandle(workflowId);
      }
      throw error;
    }
  }

  async getProjectWorkflowStatus(workflowId: string): Promise<TemporalProjectState | null> {
    const handle = this.client.workflow.getHandle(workflowId);
    try {
      return await handle.query(temporalProjectStatusQuery);
    } catch (error) {
      if (isWorkflowNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async pauseProjectWorkflow(workflowId: string): Promise<void> {
    const handle = this.client.workflow.getHandle(workflowId);
    await handle.signal(temporalProjectPauseSignal);
  }

  async resumeProjectWorkflow(workflowId: string): Promise<void> {
    const handle = this.client.workflow.getHandle(workflowId);
    await handle.signal(temporalProjectResumeSignal);
  }

  async cancelProjectWorkflow(workflowId: string): Promise<void> {
    const handle = this.client.workflow.getHandle(workflowId);
    await handle.signal(temporalProjectCancelSignal);
  }

  async getProjectWorkflowResult(workflowId: string): Promise<TemporalProjectResult | null> {
    const handle = this.client.workflow.getHandle(workflowId);
    try {
      return await handle.result();
    } catch (error) {
      if (isWorkflowNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async close() {
    await this.connection.close();
  }
}
