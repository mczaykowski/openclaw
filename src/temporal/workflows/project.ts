import {
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

export type TemporalProjectStepInput = {
  id?: string;
  title?: string;
  prompt: string;
  agentId?: string;
  actorRole?: string;
  timeoutSeconds?: number;
};

export type TemporalProjectWorkflowInput = {
  projectId: string;
  steps: TemporalProjectStepInput[];
  continueOnError?: boolean;
};

export type TemporalProjectStepState = {
  index: number;
  id: string;
  title: string;
  actorRole?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAtIso?: string;
  finishedAtIso?: string;
  summary?: string;
  outputText?: string;
  error?: string;
  runId?: string;
};

export type TemporalProjectState = {
  workflowId: string;
  projectId: string;
  phase:
    | "starting"
    | "running"
    | "finalize_notify"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";
  paused: boolean;
  cancelled: boolean;
  totalSteps: number;
  completedSteps: number;
  startedAtIso: string;
  finishedAtIso?: string;
  currentStepIndex?: number;
  currentStepId?: string;
  error?: string;
  steps: TemporalProjectStepState[];
};

export type TemporalProjectResult = {
  status: "completed" | "failed" | "cancelled";
  state: TemporalProjectState;
};

export const temporalProjectPauseSignal = defineSignal("temporalProjectPause");
export const temporalProjectResumeSignal = defineSignal("temporalProjectResume");
export const temporalProjectCancelSignal = defineSignal("temporalProjectCancel");
export const temporalProjectStatusQuery =
  defineQuery<TemporalProjectState>("temporalProjectStatus");

const { runProjectStepActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 hours",
  retry: {
    initialInterval: "15 seconds",
    maximumInterval: "5 minutes",
    backoffCoefficient: 2,
  },
});

function resolveStepId(step: TemporalProjectStepInput, index: number): string {
  const raw = step.id?.trim();
  if (raw) {
    return raw;
  }
  return `step-${index + 1}`;
}

function resolveStepTitle(step: TemporalProjectStepInput, index: number): string {
  const raw = step.title?.trim();
  if (raw) {
    return raw;
  }
  return `Step ${index + 1}`;
}

function isFinalizeNotifyStep(stepId: string): boolean {
  return stepId.trim().toLowerCase() === "finalize_notify";
}

function resolveStepActorRole(step: TemporalProjectStepInput): string {
  const explicit = step.actorRole?.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const agentId = step.agentId?.trim().toLowerCase();
  if (!agentId || agentId === "main") {
    return "zed-main";
  }
  return `agent:${agentId}`;
}

export async function temporalProjectWorkflow(
  input: TemporalProjectWorkflowInput,
): Promise<TemporalProjectResult> {
  const workflowId = workflowInfo().workflowId;
  const normalizedProjectId = input.projectId.trim() || workflowId;
  const steps = input.steps.filter((step) => step.prompt.trim().length > 0);

  const state: TemporalProjectState = {
    workflowId,
    projectId: normalizedProjectId,
    phase: "starting",
    paused: false,
    cancelled: false,
    totalSteps: steps.length,
    completedSteps: 0,
    startedAtIso: new Date().toISOString(),
    steps: steps.map((step, index) => ({
      index,
      id: resolveStepId(step, index),
      title: resolveStepTitle(step, index),
      status: "pending",
    })),
  };

  setHandler(temporalProjectPauseSignal, () => {
    state.paused = true;
    if (state.phase === "running" || state.phase === "finalize_notify") {
      state.phase = "paused";
    }
  });

  setHandler(temporalProjectResumeSignal, () => {
    state.paused = false;
    if (state.phase === "paused") {
      state.phase = "running";
    }
  });

  setHandler(temporalProjectCancelSignal, () => {
    state.cancelled = true;
  });

  setHandler(temporalProjectStatusQuery, () => state);

  if (steps.length === 0) {
    state.phase = "failed";
    state.error = "temporalProjectWorkflow requires at least one non-empty step prompt";
    state.finishedAtIso = new Date().toISOString();
    log.warn("Temporal project workflow rejected invalid input", {
      workflowId,
      projectId: normalizedProjectId,
      reason: state.error,
    });
    return { status: "failed", state };
  }

  state.phase = "running";
  log.info("Temporal project workflow started", {
    workflowId,
    projectId: normalizedProjectId,
    totalSteps: steps.length,
  });

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepState = state.steps[index];
    state.currentStepIndex = index;
    state.currentStepId = stepState.id;

    const actorRole = resolveStepActorRole(step);
    stepState.actorRole = actorRole;
    const isFinalizeNotify = isFinalizeNotifyStep(stepState.id);

    while (state.paused && !state.cancelled) {
      state.phase = "paused";
      await sleep("1s");
    }

    if (state.cancelled) {
      state.phase = "cancelled";
      stepState.status = "cancelled";
      stepState.finishedAtIso = new Date().toISOString();
      state.finishedAtIso = stepState.finishedAtIso;
      return { status: "cancelled", state };
    }

    if (isFinalizeNotify && actorRole !== "zed-main") {
      stepState.status = "failed";
      stepState.error = `finalize_notify step must run as zed-main (got ${actorRole})`;
      stepState.finishedAtIso = new Date().toISOString();
      state.phase = "failed";
      state.error = stepState.error;
      state.finishedAtIso = stepState.finishedAtIso;
      return { status: "failed", state };
    }

    state.phase = isFinalizeNotify ? "finalize_notify" : "running";
    stepState.status = "running";
    stepState.startedAtIso = new Date().toISOString();

    const result = await runProjectStepActivity({
      workflowId,
      projectId: normalizedProjectId,
      stepIndex: index,
      totalSteps: steps.length,
      step,
    });

    stepState.runId = result.runId;
    stepState.finishedAtIso = new Date().toISOString();
    if (result.status === "ok") {
      stepState.status = "completed";
      stepState.summary = result.summary;
      stepState.outputText = result.outputText;
      state.completedSteps += 1;
      continue;
    }

    stepState.status = "failed";
    stepState.error = result.error ?? "unknown project step error";
    if (isFinalizeNotify) {
      state.phase = "failed";
      state.error = stepState.error;
      state.finishedAtIso = stepState.finishedAtIso;
      return { status: "failed", state };
    }
    if (input.continueOnError) {
      continue;
    }

    state.phase = "failed";
    state.error = stepState.error;
    state.finishedAtIso = stepState.finishedAtIso;
    return { status: "failed", state };
  }

  state.finishedAtIso = new Date().toISOString();
  if (state.steps.some((step) => step.status === "failed")) {
    state.phase = "failed";
    state.error = state.steps.find((step) => step.status === "failed")?.error;
    return { status: "failed", state };
  }

  state.phase = "completed";
  return { status: "completed", state };
}
