import { Connection, Client } from "@temporalio/client";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { agentHeartbeatWorkflow } from "../workflows/index.js";

const log = createSubsystemLogger("temporal/client");

export type TemporalClientOptions = {
  address?: string;
  namespace?: string;
};

/**
 * A client that can interact with the Temporal cluster to start and manage OpenClaw workflows.
 */
export class OpenClawTemporalClient {
  private client: Client;
  private connection: Connection;

  private constructor(client: Client, connection: Connection) {
    this.client = client;
    this.connection = connection;
  }

  static async connect(opts: TemporalClientOptions = {}) {
    const address = opts.address ?? "127.0.0.1:7233";
    const namespace = opts.namespace ?? "default";

    log.info("Connecting to Temporal Cluster", { address, namespace });

    try {
      const connection = await Connection.connect({ address });
      const client = new Client({ connection, namespace });
      return new OpenClawTemporalClient(client, connection);
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
        taskQueue: "openclaw-tasks",
        workflowId,
        args: [agentId, intervalMs],
      });
      return handle;
    } catch (error) {
      log.error("Failed to start heartbeat workflow", { agentId, error: String(error) });
      throw error;
    }
  }

  async close() {
    await this.connection.close();
  }
}
