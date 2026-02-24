import type { TemporalProjectStepInput } from "../workflows/project.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { agentCommand } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";

const log = createSubsystemLogger("temporal/activities");

export type TemporalProjectStepActivityInput = {
  workflowId: string;
  projectId: string;
  stepIndex: number;
  totalSteps: number;
  step: TemporalProjectStepInput;
};

export type TemporalProjectStepActivityResult = {
  status: "ok" | "error";
  runId: string;
  summary?: string;
  outputText?: string;
  error?: string;
};

function pickLastPayloadText(payloads: Array<{ text?: string }>): string | undefined {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const text = payloads[index]?.text?.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function toSummary(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function sanitizeRunSegment(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return "step";
  }
  const normalized = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 32) || "step";
}

export async function runProjectStepActivity(
  input: TemporalProjectStepActivityInput,
): Promise<TemporalProjectStepActivityResult> {
  const cfg = loadConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const agentId = input.step.agentId?.trim() || defaultAgentId;
  const stepId = input.step.id?.trim() || `step-${input.stepIndex + 1}`;
  const timeoutSeconds =
    typeof input.step.timeoutSeconds === "number" && Number.isFinite(input.step.timeoutSeconds)
      ? Math.max(0, Math.floor(input.step.timeoutSeconds))
      : undefined;
  const runId = `temporal-${sanitizeRunSegment(input.workflowId)}-${input.stepIndex + 1}-${sanitizeRunSegment(stepId)}`;

  log.info("Running temporal project step activity", {
    workflowId: input.workflowId,
    projectId: input.projectId,
    stepIndex: input.stepIndex,
    stepId,
    agentId,
    runId,
  });

  try {
    const result = await agentCommand(
      {
        message: input.step.prompt,
        agentId,
        lane: "temporal",
        runId,
        timeout: timeoutSeconds !== undefined ? String(timeoutSeconds) : undefined,
        deliver: false,
      },
      defaultRuntime,
      createDefaultDeps(),
    );

    const outputText = pickLastPayloadText((result.payloads ?? []) as Array<{ text?: string }>);
    return {
      status: "ok",
      runId,
      outputText,
      summary: toSummary(outputText),
    };
  } catch (error) {
    const err = String(error);
    log.error("Temporal project step activity failed", {
      workflowId: input.workflowId,
      projectId: input.projectId,
      stepIndex: input.stepIndex,
      stepId,
      agentId,
      runId,
      error: err,
    });
    return { status: "error", runId, error: err };
  }
}
