import { Worker, NativeConnection } from "@temporalio/worker";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import * as activities from "../activities/index.js";

const log = createSubsystemLogger("temporal/worker");

export type TemporalWorkerOptions = {
  address?: string;
  namespace?: string;
  taskQueue?: string;
};

/**
 * Starts a Temporal Worker that can execute OpenClaw workflows and activities.
 */
export async function startTemporalWorker(opts: TemporalWorkerOptions = {}) {
  const address = opts.address ?? "127.0.0.1:7233";
  const namespace = opts.namespace ?? "default";
  const taskQueue = opts.taskQueue ?? "openclaw-tasks";

  log.info("Starting Temporal Worker", { address, namespace, taskQueue });

  try {
    const connection = await NativeConnection.connect({
      address,
    });

    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      workflowsPath: new URL("../workflows/index.js", import.meta.url).pathname,
      activities,
    });

    // Start running the worker
    void worker.run().catch((err) => {
      log.error("Temporal Worker crashed", { error: String(err) });
    });

    log.info("Temporal Worker is running and polling for tasks");

    return {
      stop: async () => {
        log.info("Stopping Temporal Worker");
        worker.shutdown();
        await connection.close();
      },
    };
  } catch (error) {
    log.error("Failed to start Temporal Worker", { error: String(error) });
    throw error;
  }
}
