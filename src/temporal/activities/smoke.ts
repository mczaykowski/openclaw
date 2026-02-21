import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("temporal/activities");

export async function runTemporalSmokeActivity(input: { startedAtIso: string }): Promise<{
  startedAtIso: string;
  finishedAtIso: string;
}> {
  log.info("Running temporal smoke activity", { startedAtIso: input.startedAtIso });
  return {
    startedAtIso: input.startedAtIso,
    finishedAtIso: new Date().toISOString(),
  };
}
