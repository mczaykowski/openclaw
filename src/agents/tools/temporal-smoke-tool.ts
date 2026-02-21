import { Type } from "@sinclair/typebox";
import { Client, Connection } from "@temporalio/client";
import crypto from "node:crypto";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { temporalSmokeWorkflow } from "../../temporal/workflows/smoke.js";
import { jsonResult, readNumberParam } from "./common.js";

const log = createSubsystemLogger("temporal/smoke-tool");

const TemporalSmokeToolSchema = Type.Object({
  ticks: Type.Optional(Type.Number({ minimum: 1 })),
  tickMs: Type.Optional(Type.Number({ minimum: 200 })),
});

type TemporalSmokeToolArgs = {
  ticks?: number;
  tickMs?: number;
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTemporalSmokeTool(): AnyAgentTool {
  return {
    label: "Temporal",
    name: "temporal_smoke",
    description:
      "Run a Temporal smoke test (start workflow, run activity, query state, send pause/resume signals).",
    parameters: TemporalSmokeToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const ticks = readNumberParam(args, "ticks", { integer: true });
      const tickMs = readNumberParam(args, "tickMs", { integer: true });

      const cfg = loadConfig();
      const temporal = cfg.temporal;
      if (!temporal?.enabled) {
        return jsonResult({
          status: "disabled",
          error: "Temporal is not enabled (temporal.enabled=false)",
        });
      }

      const address = temporal.address ?? "127.0.0.1:7233";
      const namespace = temporal.namespace ?? "default";
      const taskQueue = temporal.taskQueue ?? "openclaw-tasks";
      const workflowId = `smoke-${crypto.randomUUID()}`;

      log.info("Starting Temporal smoke workflow", { address, namespace, taskQueue, workflowId });

      const connection = await Connection.connect({ address });
      try {
        const client = new Client({ connection, namespace });

        const handle = await client.workflow.start(temporalSmokeWorkflow, {
          workflowId,
          taskQueue,
          args: [{ ticks, tickMs } satisfies TemporalSmokeToolArgs],
        });

        // Allow the workflow to start before we query/signal.
        await sleepMs(750);

        let statusBefore: unknown;
        try {
          statusBefore = await handle.query("temporalSmokeStatus");
        } catch (err) {
          statusBefore = { error: String(err) };
        }

        await handle.signal("temporalSmokePause");
        await sleepMs(750);

        let statusPaused: unknown;
        try {
          statusPaused = await handle.query("temporalSmokeStatus");
        } catch (err) {
          statusPaused = { error: String(err) };
        }

        await handle.signal("temporalSmokeResume");

        const result = await handle.result();

        return jsonResult({
          status: "ok",
          workflowId,
          runId: handle.firstExecutionRunId,
          statusBefore,
          statusPaused,
          result,
        });
      } finally {
        await connection.close();
      }
    },
  };
}
