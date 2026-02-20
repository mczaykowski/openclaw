import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { agentHeartbeatWorkflow } from "../workflows/index.js";

const log = createSubsystemLogger("temporal/client");

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

  async close() {
    await this.connection.close();
  }
}
