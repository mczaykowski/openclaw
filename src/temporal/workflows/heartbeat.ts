import { proxyActivities, sleep, log } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { runAgentHeartbeat } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1 minute",
    maximumInterval: "10 minutes",
    backoffCoefficient: 2,
  },
});

/**
 * A durable workflow that runs a periodic heartbeat for an agent.
 * This replaces the local setInterval logic.
 */
export async function agentHeartbeatWorkflow(agentId: string, intervalMs: number): Promise<void> {
  log.info("Starting durable heartbeat workflow", { agentId, intervalMs });

  // Infinite loop supported by Temporal
  while (true) {
    try {
      await runAgentHeartbeat(agentId);
    } catch (err) {
      log.error("Heartbeat activity failed, will retry", { agentId, error: String(err) });
      // We don't throw here to keep the workflow alive
    }

    // Durable sleep - this can last for months and survives server reboots/crashes
    await sleep(intervalMs);
  }
}
