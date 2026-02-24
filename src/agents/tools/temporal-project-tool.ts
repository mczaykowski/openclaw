import { Type } from "@sinclair/typebox";
import type { TemporalProjectStepInput } from "../../temporal/workflows/index.js";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { OpenClawTemporalClient } from "../../temporal/client/index.js";
import { ToolInputError, jsonResult, readNumberParam, readStringParam } from "./common.js";

const log = createSubsystemLogger("temporal/project-tool");

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_ISSUE_LIMIT = 10;
const MAX_LINEAR_ISSUES = 50;

type LinearProject = {
  id: string;
  name: string;
  teams?: {
    nodes?: Array<{
      key?: string | null;
      name?: string | null;
    }>;
  };
};

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  state?: {
    name?: string | null;
    type?: string | null;
  } | null;
  assignee?: {
    name?: string | null;
  } | null;
};

const TemporalProjectActionSchema = Type.Union([
  Type.Literal("start"),
  Type.Literal("status"),
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("cancel"),
  Type.Literal("result"),
  Type.Literal("preview_linear"),
  Type.Literal("start_from_linear"),
]);

const TemporalProjectStepSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  title: Type.Optional(Type.String({ minLength: 1 })),
  prompt: Type.String({ minLength: 1 }),
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  actorRole: Type.Optional(Type.String({ minLength: 1 })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

const TemporalProjectToolSchema = Type.Object({
  action: Type.Optional(TemporalProjectActionSchema),
  workflowId: Type.Optional(Type.String({ minLength: 1 })),
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  steps: Type.Optional(Type.Array(TemporalProjectStepSchema, { minItems: 1 })),
  continueOnError: Type.Optional(Type.Boolean()),
  waitForCompletion: Type.Optional(Type.Boolean()),
  linearApiKey: Type.Optional(Type.String({ minLength: 1 })),
  linearProject: Type.Optional(Type.String({ minLength: 1 })),
  linearTeamKey: Type.Optional(Type.String({ minLength: 1 })),
  linearIssueLimit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LINEAR_ISSUES })),
  linearIncludeCompleted: Type.Optional(Type.Boolean()),
});

type TemporalProjectAction =
  | "start"
  | "status"
  | "pause"
  | "resume"
  | "cancel"
  | "result"
  | "preview_linear"
  | "start_from_linear";

function resolveAction(args: Record<string, unknown>): TemporalProjectAction {
  const action = readStringParam(args, "action", { trim: true })?.toLowerCase();
  if (action === undefined) {
    return Array.isArray(args.steps) ? "start" : "status";
  }
  if (
    action === "start" ||
    action === "status" ||
    action === "pause" ||
    action === "resume" ||
    action === "cancel" ||
    action === "result" ||
    action === "preview_linear" ||
    action === "start_from_linear"
  ) {
    return action;
  }
  throw new ToolInputError(
    "action must be one of: start, status, pause, resume, cancel, result, preview_linear, start_from_linear",
  );
}

function parseStep(raw: unknown, index: number): TemporalProjectStepInput {
  if (!raw || typeof raw !== "object") {
    throw new ToolInputError(`steps[${index}] must be an object`);
  }
  const candidate = raw as Record<string, unknown>;
  const prompt = readStringParam(candidate, "prompt", {
    required: true,
    label: `steps[${index}].prompt`,
  });
  const id = readStringParam(candidate, "id", {
    label: `steps[${index}].id`,
  });
  const title = readStringParam(candidate, "title", {
    label: `steps[${index}].title`,
  });
  const agentId = readStringParam(candidate, "agentId", {
    label: `steps[${index}].agentId`,
  });
  const actorRole = readStringParam(candidate, "actorRole", {
    label: `steps[${index}].actorRole`,
  });

  let timeoutSeconds: number | undefined;
  if (typeof candidate.timeoutSeconds === "number" && Number.isFinite(candidate.timeoutSeconds)) {
    timeoutSeconds = Math.max(0, Math.floor(candidate.timeoutSeconds));
  } else if (candidate.timeoutSeconds !== undefined) {
    throw new ToolInputError(`steps[${index}].timeoutSeconds must be a number`);
  }

  return {
    id,
    title,
    prompt,
    agentId,
    actorRole,
    timeoutSeconds,
  };
}

function parseSteps(args: Record<string, unknown>): TemporalProjectStepInput[] {
  const raw = args.steps;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolInputError("steps must be a non-empty array");
  }
  return raw.map((entry, index) => parseStep(entry, index));
}

function isFinalizeNotifyStep(step: TemporalProjectStepInput): boolean {
  return step.id?.trim().toLowerCase() === "finalize_notify";
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

function assertFinalizeNotifyOwnership(steps: TemporalProjectStepInput[]) {
  for (const step of steps) {
    if (!isFinalizeNotifyStep(step)) {
      continue;
    }
    const actorRole = resolveStepActorRole(step);
    if (actorRole !== "zed-main") {
      throw new ToolInputError(`finalize_notify step must run as zed-main (got ${actorRole})`);
    }
  }
}

function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

function resolveLinearApiKey(args: Record<string, unknown>): string {
  const explicit = readStringParam(args, "linearApiKey", { label: "linearApiKey" });
  const fromEnv = process.env.LINEAR_API_KEY?.trim();
  const apiKey = explicit ?? fromEnv;
  if (!apiKey) {
    throw new ToolInputError("LINEAR_API_KEY missing (set env or pass linearApiKey)");
  }
  return apiKey;
}

function isLinearIssueCompleted(issue: LinearIssue): boolean {
  const type = issue.state?.type?.trim().toLowerCase();
  if (!type) {
    return false;
  }
  return type === "completed" || type === "canceled" || type === "cancelled" || type === "done";
}

function normalizeLinearPriority(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 99;
  }
  return Math.floor(value);
}

async function linearGraphqlRequest<T>(params: {
  apiKey: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: params.apiKey,
    },
    body: JSON.stringify({
      query: params.query,
      variables: params.variables ?? {},
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Linear GraphQL HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0]?.message?.trim() || "unknown Linear GraphQL error";
    throw new Error(first);
  }
  if (!payload.data) {
    throw new Error("Linear GraphQL response missing data");
  }
  return payload.data;
}

async function resolveLinearProject(params: {
  apiKey: string;
  projectRef: string;
  teamKey?: string;
}): Promise<{ project: LinearProject; totalProjectsScanned: number }> {
  const data = await linearGraphqlRequest<{
    projects?: {
      nodes?: LinearProject[];
    };
  }>({
    apiKey: params.apiKey,
    query: `
      query($first:Int!){
        projects(first:$first){
          nodes {
            id
            name
            teams {
              nodes {
                key
                name
              }
            }
          }
        }
      }
    `,
    variables: {
      first: 100,
    },
  });

  const projects = Array.isArray(data.projects?.nodes) ? data.projects.nodes : [];
  const refRaw = params.projectRef.trim();
  const refLower = refRaw.toLowerCase();
  const teamKeyLower = params.teamKey?.trim().toLowerCase();

  let matches = projects.filter((project) => project.id === refRaw);
  if (matches.length === 0) {
    matches = projects.filter((project) => project.name.trim().toLowerCase() === refLower);
  }
  if (matches.length === 0) {
    matches = projects.filter((project) => project.name.trim().toLowerCase().includes(refLower));
  }

  if (teamKeyLower) {
    matches = matches.filter((project) =>
      (project.teams?.nodes ?? []).some((team) => team.key?.trim().toLowerCase() === teamKeyLower),
    );
  }

  if (matches.length === 0) {
    throw new ToolInputError(
      teamKeyLower
        ? `Linear project "${params.projectRef}" not found for team "${params.teamKey}"`
        : `Linear project "${params.projectRef}" not found`,
    );
  }

  if (matches.length > 1) {
    const sample = matches
      .slice(0, 5)
      .map((project) => `${project.name} (${project.id})`)
      .join(", ");
    throw new ToolInputError(
      `Linear project reference is ambiguous; use exact name or id. Matches: ${sample}`,
    );
  }

  return {
    project: matches[0],
    totalProjectsScanned: projects.length,
  };
}

async function loadLinearProjectIssues(params: {
  apiKey: string;
  projectId: string;
  issueLimit: number;
}): Promise<LinearIssue[]> {
  const data = await linearGraphqlRequest<{
    project?: {
      id: string;
      name: string;
      issues?: {
        nodes?: LinearIssue[];
      };
    } | null;
  }>({
    apiKey: params.apiKey,
    query: `
      query($projectId:String!,$first:Int!){
        project(id:$projectId){
          id
          name
          issues(first:$first){
            nodes {
              id
              identifier
              title
              description
              url
              priority
              state {
                name
                type
              }
              assignee {
                name
              }
            }
          }
        }
      }
    `,
    variables: {
      projectId: params.projectId,
      first: params.issueLimit,
    },
  });

  return Array.isArray(data.project?.issues?.nodes) ? data.project.issues.nodes : [];
}

function mapLinearIssueToTemporalStep(issue: LinearIssue): TemporalProjectStepInput {
  const stateName = issue.state?.name?.trim() || "Unknown";
  const stateType = issue.state?.type?.trim() || "unknown";
  const assignee = issue.assignee?.name?.trim() || "Unassigned";
  const description =
    typeof issue.description === "string" && issue.description.trim().length > 0
      ? truncateText(issue.description, 4_000)
      : "(No description provided in Linear)";
  const priorityLabel =
    typeof issue.priority === "number" && issue.priority > 0 ? String(issue.priority) : "none";

  return {
    id: issue.identifier,
    title: issue.title,
    prompt: [
      `Implement Linear issue ${issue.identifier}: ${issue.title}`,
      `Linear URL: ${issue.url?.trim() || "(missing)"}`,
      `State: ${stateName} (${stateType})`,
      `Priority: ${priorityLabel}`,
      `Assignee: ${assignee}`,
      "",
      "Context from Linear:",
      description,
      "",
      "Task requirements:",
      "- Complete the implementation for this issue.",
      "- If blocked, explain blockers and propose next actions.",
      "- Return a concise summary of changes and verification.",
    ].join("\n"),
  };
}

async function resolveLinearBackedSteps(args: Record<string, unknown>): Promise<{
  project: LinearProject;
  steps: TemporalProjectStepInput[];
  issues: Array<{
    id: string;
    identifier: string;
    title: string;
    priority: number | null;
    url: string | null;
    state: string | null;
    stateType: string | null;
  }>;
  totalProjectsScanned: number;
}> {
  const projectRef = readStringParam(args, "linearProject", {
    required: true,
    label: "linearProject",
  });
  const teamKey = readStringParam(args, "linearTeamKey", {
    label: "linearTeamKey",
  });
  const includeCompleted =
    typeof args.linearIncludeCompleted === "boolean" && args.linearIncludeCompleted;
  const limitRaw = readNumberParam(args, "linearIssueLimit", {
    label: "linearIssueLimit",
    integer: true,
  });
  const issueLimit = Math.max(
    1,
    Math.min(
      MAX_LINEAR_ISSUES,
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.floor(limitRaw)
        : DEFAULT_LINEAR_ISSUE_LIMIT,
    ),
  );
  const apiKey = resolveLinearApiKey(args);

  const { project, totalProjectsScanned } = await resolveLinearProject({
    apiKey,
    projectRef,
    teamKey,
  });

  const rawIssues = await loadLinearProjectIssues({
    apiKey,
    projectId: project.id,
    issueLimit,
  });

  const filteredIssues = includeCompleted
    ? rawIssues
    : rawIssues.filter((issue) => !isLinearIssueCompleted(issue));

  filteredIssues.sort((a, b) => {
    const priorityDiff = normalizeLinearPriority(a.priority) - normalizeLinearPriority(b.priority);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return a.identifier.localeCompare(b.identifier);
  });

  return {
    project,
    steps: filteredIssues.map((issue) => mapLinearIssueToTemporalStep(issue)),
    issues: filteredIssues.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      priority: issue.priority ?? null,
      url: issue.url ?? null,
      state: issue.state?.name ?? null,
      stateType: issue.state?.type ?? null,
    })),
    totalProjectsScanned,
  };
}

export function createTemporalProjectTool(): AnyAgentTool {
  return {
    label: "Temporal",
    name: "temporal_project",
    description:
      "Run durable multi-step agent workflows in Temporal, including auto-mapping from Linear projects.",
    parameters: TemporalProjectToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;

      const cfg = loadConfig();
      const temporal = cfg.temporal;
      if (!temporal?.enabled) {
        return jsonResult({
          status: "disabled",
          error: "Temporal is not enabled (temporal.enabled=false)",
        });
      }

      const action = resolveAction(args);
      const workflowId = readStringParam(args, "workflowId", {
        label: "workflowId",
      });

      let temporalClientInstance: OpenClawTemporalClient | undefined;
      const ensureClient = async (): Promise<OpenClawTemporalClient> => {
        if (temporalClientInstance === undefined) {
          temporalClientInstance = await OpenClawTemporalClient.connect({
            address: temporal.address,
            namespace: temporal.namespace,
            taskQueue: temporal.taskQueue,
          });
        }
        return temporalClientInstance;
      };

      try {
        if (action === "preview_linear" || action === "start_from_linear") {
          const mapped = await resolveLinearBackedSteps(args);
          if (mapped.steps.length === 0) {
            return jsonResult({
              status: "empty",
              action,
              linearProject: {
                id: mapped.project.id,
                name: mapped.project.name,
              },
              totalProjectsScanned: mapped.totalProjectsScanned,
              issueCount: 0,
              issues: [],
            });
          }

          if (action === "preview_linear") {
            return jsonResult({
              status: "ok",
              action,
              linearProject: {
                id: mapped.project.id,
                name: mapped.project.name,
              },
              totalProjectsScanned: mapped.totalProjectsScanned,
              issueCount: mapped.issues.length,
              issues: mapped.issues,
              stepsPreview: mapped.steps.map((step) => ({
                id: step.id,
                title: step.title,
              })),
            });
          }

          const temporalClient = await ensureClient();
          assertFinalizeNotifyOwnership(mapped.steps);
          const continueOnError = typeof args.continueOnError === "boolean" && args.continueOnError;
          const waitForCompletion =
            typeof args.waitForCompletion === "boolean" && args.waitForCompletion;
          const temporalProjectId =
            readStringParam(args, "projectId", { label: "projectId" }) ?? mapped.project.name;

          const handle = await temporalClient.startProjectWorkflow({
            projectId: temporalProjectId,
            steps: mapped.steps,
            continueOnError,
            workflowId,
          });

          if (waitForCompletion) {
            const result = await temporalClient.getProjectWorkflowResult(handle.workflowId);
            return jsonResult({
              status: result?.status ?? "not-found",
              action,
              workflowId: handle.workflowId,
              projectId: temporalProjectId,
              linearProject: {
                id: mapped.project.id,
                name: mapped.project.name,
              },
              issueCount: mapped.issues.length,
              issues: mapped.issues,
              result,
            });
          }

          return jsonResult({
            status: "started",
            action,
            workflowId: handle.workflowId,
            projectId: temporalProjectId,
            linearProject: {
              id: mapped.project.id,
              name: mapped.project.name,
            },
            issueCount: mapped.issues.length,
            issues: mapped.issues,
            continueOnError,
          });
        }

        const temporalClient = await ensureClient();

        if (action === "start") {
          const projectId = readStringParam(args, "projectId", {
            required: true,
            label: "projectId",
          });
          const steps = parseSteps(args);
          assertFinalizeNotifyOwnership(steps);
          const continueOnError = typeof args.continueOnError === "boolean" && args.continueOnError;
          const waitForCompletion =
            typeof args.waitForCompletion === "boolean" && args.waitForCompletion;

          const handle = await temporalClient.startProjectWorkflow({
            projectId,
            steps,
            continueOnError,
            workflowId,
          });

          if (waitForCompletion) {
            const result = await temporalClient.getProjectWorkflowResult(handle.workflowId);
            return jsonResult({
              status: result?.status ?? "not-found",
              workflowId: handle.workflowId,
              result,
            });
          }

          return jsonResult({
            status: "started",
            workflowId: handle.workflowId,
            projectId,
            steps: steps.length,
            continueOnError,
          });
        }

        if (!workflowId) {
          throw new ToolInputError("workflowId required for this action");
        }

        if (action === "status") {
          const status = await temporalClient.getProjectWorkflowStatus(workflowId);
          return jsonResult({
            status: status ? "ok" : "not-found",
            workflowId,
            workflow: status,
          });
        }

        if (action === "result") {
          const result = await temporalClient.getProjectWorkflowResult(workflowId);
          return jsonResult({
            status: result ? "ok" : "not-found",
            workflowId,
            result,
          });
        }

        if (action === "pause") {
          await temporalClient.pauseProjectWorkflow(workflowId);
          return jsonResult({ status: "ok", workflowId, action });
        }

        if (action === "resume") {
          await temporalClient.resumeProjectWorkflow(workflowId);
          return jsonResult({ status: "ok", workflowId, action });
        }

        await temporalClient.cancelProjectWorkflow(workflowId);
        return jsonResult({ status: "ok", workflowId, action: "cancel" });
      } catch (error) {
        log.error("temporal_project tool failed", { action, workflowId, error: String(error) });
        throw error;
      } finally {
        if (temporalClientInstance !== undefined) {
          await temporalClientInstance.close();
        }
      }
    },
  };
}
