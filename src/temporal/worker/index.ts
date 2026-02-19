import { Worker, NativeConnection } from "@temporalio/worker";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import * as activities from "../activities/index.js";

const log = createSubsystemLogger("temporal/worker");

function resolveWorkflowsPath(): string {
  // Useful for deployments that keep workflow code elsewhere.
  const override = process.env.OPENCLAW_TEMPORAL_WORKFLOWS_PATH;
  if (override) {
    return override;
  }

  // When bundled, `import.meta.url` points at dist/entry.js (so moduleDir === <root>/dist)
  // When running from source, `import.meta.url` points at src/temporal/worker/index.ts.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  const distCandidate = path.resolve(moduleDir, "temporal/workflows/index.js");
  if (fs.existsSync(distCandidate)) {
    return distCandidate;
  }

  // Dev/source fallback.
  const srcCandidate = path.resolve(moduleDir, "../workflows/index.ts");
  if (fs.existsSync(srcCandidate)) {
    return srcCandidate;
  }

  // Historical fallback (older builds expected this to exist).
  return path.resolve(moduleDir, "../workflows/index.js");
}

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

  const workflowsPath = resolveWorkflowsPath();

  log.info("Starting Temporal Worker", { address, namespace, taskQueue, workflowsPath });

  try {
    const connection = await NativeConnection.connect({
      address,
    });

    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      workflowsPath,
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
