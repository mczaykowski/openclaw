import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";

export const HANDOFF_STATUS_VALUES = ["todo", "in_progress", "blocked", "done"] as const;
export type AgentHandoffStatus = (typeof HANDOFF_STATUS_VALUES)[number];

export type AgentHandoffPayload = {
  task_id: string;
  objective: string;
  constraints: string[];
  artifacts: string[];
  status: AgentHandoffStatus;
  next_actor: string;
  notify_target: string;
};

export const AgentHandoffPayloadSchema = Type.Object(
  {
    task_id: Type.String({ minLength: 1 }),
    objective: Type.String({ minLength: 1 }),
    constraints: Type.Array(Type.String()),
    artifacts: Type.Array(Type.String()),
    status: Type.String({ enum: [...HANDOFF_STATUS_VALUES] }),
    next_actor: Type.String({ minLength: 1 }),
    notify_target: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

type HandoffParseResult = { ok: true; handoff: AgentHandoffPayload } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseRequiredString(
  record: Record<string, unknown>,
  key: keyof AgentHandoffPayload,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = record[String(key)];
  if (typeof raw !== "string") {
    return { ok: false, error: `handoff.${String(key)} must be a string` };
  }
  const value = raw.trim();
  if (!value) {
    return { ok: false, error: `handoff.${String(key)} is required` };
  }
  return { ok: true, value };
}

function parseStringArray(
  record: Record<string, unknown>,
  key: "constraints" | "artifacts",
): { ok: true; value: string[] } | { ok: false; error: string } {
  const raw = record[key];
  if (!Array.isArray(raw)) {
    return { ok: false, error: `handoff.${key} must be an array of strings` };
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      return { ok: false, error: `handoff.${key}[${i}] must be a string` };
    }
    const trimmed = entry.trim();
    if (trimmed) {
      out.push(trimmed);
    }
  }
  return { ok: true, value: out };
}

function isValidStatus(value: string): value is AgentHandoffStatus {
  return (HANDOFF_STATUS_VALUES as readonly string[]).includes(value);
}

export function parseAgentHandoffPayload(raw: unknown): HandoffParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "handoff must be an object" };
  }

  const taskId = parseRequiredString(raw, "task_id");
  if (!taskId.ok) {
    return taskId;
  }
  const objective = parseRequiredString(raw, "objective");
  if (!objective.ok) {
    return objective;
  }
  const constraints = parseStringArray(raw, "constraints");
  if (!constraints.ok) {
    return constraints;
  }
  const artifacts = parseStringArray(raw, "artifacts");
  if (!artifacts.ok) {
    return artifacts;
  }
  const statusRaw = parseRequiredString(raw, "status");
  if (!statusRaw.ok) {
    return statusRaw;
  }
  const status = statusRaw.value.toLowerCase();
  if (!isValidStatus(status)) {
    return {
      ok: false,
      error: `handoff.status must be one of: ${HANDOFF_STATUS_VALUES.join(", ")}`,
    };
  }
  const nextActor = parseRequiredString(raw, "next_actor");
  if (!nextActor.ok) {
    return nextActor;
  }
  const notifyTarget = parseRequiredString(raw, "notify_target");
  if (!notifyTarget.ok) {
    return notifyTarget;
  }

  return {
    ok: true,
    handoff: {
      task_id: taskId.value,
      objective: objective.value,
      constraints: constraints.value,
      artifacts: artifacts.value,
      status,
      next_actor: nextActor.value,
      notify_target: notifyTarget.value,
    },
  };
}

export function createDefaultHandoffPayload(params: {
  objective: string;
  nextActor: string;
  notifyTarget: string;
}): AgentHandoffPayload {
  const taskHash = crypto
    .createHash("sha1")
    .update(`${params.objective}:${Date.now().toString(36)}`)
    .digest("hex")
    .slice(0, 12);
  return {
    task_id: `task-${taskHash}`,
    objective: params.objective.trim(),
    constraints: [],
    artifacts: [],
    status: "todo",
    next_actor: params.nextActor.trim() || "worker",
    notify_target: params.notifyTarget.trim() || "main",
  };
}

export function buildHandoffPrompt(params: {
  handoff: AgentHandoffPayload;
  guidance?: string;
}): string {
  const lines: string[] = [
    "Structured handoff payload (authoritative):",
    JSON.stringify(params.handoff, null, 2),
    "",
    "Execution requirements:",
    "- Follow objective and constraints exactly.",
    "- Update or produce artifacts listed in the payload.",
    "- Keep status aligned with actual progress.",
    "- Notify the target when completed or blocked.",
  ];
  const guidance = params.guidance?.trim();
  if (guidance) {
    lines.push("", `Additional guidance: ${guidance}`);
  }
  return lines.join("\n");
}
