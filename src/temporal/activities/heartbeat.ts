import { runHeartbeatOnce } from "../../infra/heartbeat-runner.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("temporal/activities");

/**
 * Activity that executes a single heartbeat for a specific agent.
 * This is called by the durable workflow.
 */
export async function runAgentHeartbeat(agentId: string) {
  log.info("Running agent heartbeat activity", { agentId });
  try {
    const result = await runHeartbeatOnce({ agentId, reason: "temporal-workflow" });
    return result;
  } catch (error) {
    log.error("Heartbeat activity failed", { agentId, error: String(error) });
    throw error; // Let Temporal handle retries
  }
}
