import {
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

export type TemporalSmokeState = {
  phase: "starting" | "running" | "paused" | "completed";
  ticks: number;
  paused: boolean;
  lastSignal?: "pause" | "resume";
  activity?: {
    startedAtIso: string;
    finishedAtIso: string;
  };
};

export const temporalSmokePauseSignal = defineSignal("temporalSmokePause");
export const temporalSmokeResumeSignal = defineSignal("temporalSmokeResume");
export const temporalSmokeStatusQuery = defineQuery<TemporalSmokeState>("temporalSmokeStatus");

const { runTemporalSmokeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
  },
});

/**
 * Small workflow used to validate end-to-end Temporal integration:
 * - Workflow start
 * - Activity execution
 * - Query handler
 * - Signal handler
 *
 * Keep this short-lived and safe.
 */
export async function temporalSmokeWorkflow(params?: {
  ticks?: number;
  tickMs?: number;
}): Promise<TemporalSmokeState> {
  const totalTicks = Math.max(1, Math.floor(params?.ticks ?? 6));
  const tickMs = Math.max(200, Math.floor(params?.tickMs ?? 750));

  const state: TemporalSmokeState = {
    phase: "starting",
    ticks: 0,
    paused: false,
  };

  setHandler(temporalSmokePauseSignal, () => {
    state.paused = true;
    state.phase = "paused";
    state.lastSignal = "pause";
  });

  setHandler(temporalSmokeResumeSignal, () => {
    state.paused = false;
    state.phase = "running";
    state.lastSignal = "resume";
  });

  setHandler(temporalSmokeStatusQuery, () => state);

  log.info("Temporal smoke workflow started", { totalTicks, tickMs });

  state.phase = "running";

  const activityResult = await runTemporalSmokeActivity({
    startedAtIso: new Date().toISOString(),
  });
  state.activity = {
    startedAtIso: activityResult.startedAtIso,
    finishedAtIso: activityResult.finishedAtIso,
  };

  for (let i = 0; i < totalTicks; i += 1) {
    if (state.paused) {
      await sleep("250ms");
      continue;
    }
    state.ticks += 1;
    await sleep(tickMs);
  }

  state.phase = "completed";
  log.info("Temporal smoke workflow completed", { ticks: state.ticks });

  return state;
}
