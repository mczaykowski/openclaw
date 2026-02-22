import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SkillSnapshot } from "./skills/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPlainObject } from "../utils.js";
import { jsonResult } from "./tools/common.js";

const log = createSubsystemLogger("agent/mcp-embedded");

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MCP_INIT_TIMEOUT_MS = 60_000;
const MCP_LIST_TIMEOUT_MS = 15_000;
const MCP_CALL_TIMEOUT_MS = 60_000;
const MCP_SHUTDOWN_TIMEOUT_MS = 2_500;
const MCP_EXIT_GRACE_MS = 1_500;
const MCP_TOOL_NAME_MAX_LENGTH = 64;

type McpPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  abortCleanup?: () => void;
};

type McpToolListEntry = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type McpServerSpec = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

type EmbeddedMcpToolHandle = {
  tools: AnyAgentTool[];
  cleanup: () => Promise<void>;
};

type McpFraming = "line" | "header";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return String(err);
}

export function resolveMcpEnvValue(value: string): string {
  return value.replace(
    MCP_ENV_VAR_PATTERN,
    (_match, envName: string) => process.env[envName] ?? "",
  );
}

function normalizeMcpToolNameSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

function normalizeMcpToolSchema(inputSchema: unknown): Record<string, unknown> {
  if (isPlainObject(inputSchema)) {
    return inputSchema;
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function normalizeServerSpec(spec: unknown): McpServerSpec | null {
  if (!isPlainObject(spec)) {
    return null;
  }
  const name = typeof spec.name === "string" ? spec.name.trim() : "";
  const command = typeof spec.command === "string" ? spec.command.trim() : "";
  if (!name || !command) {
    return null;
  }

  const args = Array.isArray(spec.args)
    ? spec.args
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

  let env: Record<string, string> | undefined;
  if (isPlainObject(spec.env)) {
    const entries = Object.entries(spec.env)
      .map(([key, value]) => [key.trim(), value] as const)
      .filter(([key, value]) => key.length > 0 && typeof value === "string")
      .map(([key, value]) => [key, resolveMcpEnvValue(String(value))] as const);
    if (entries.length > 0) {
      env = Object.fromEntries(entries);
    }
  }

  return {
    name,
    command,
    args,
    env,
  };
}

function resolveSnapshotMcpServers(snapshot?: SkillSnapshot): McpServerSpec[] {
  const byName = new Map<string, McpServerSpec>();
  for (const raw of snapshot?.mcpServers ?? []) {
    const normalized = normalizeServerSpec(raw);
    if (!normalized) {
      continue;
    }
    byName.set(normalized.name, normalized);
  }
  return Array.from(byName.values());
}

class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private readonly pending = new Map<number, McpPendingRequest>();
  private closed = false;

  private constructor(
    private readonly serverName: string,
    private readonly framing: McpFraming,
    child: ChildProcessWithoutNullStreams,
  ) {
    this.child = child;
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) {
        log.debug(`[${this.serverName}] ${line}`);
      }
    });
    this.child.on("error", (err) => {
      this.failAllPending(new Error(`[${this.serverName}] process error: ${toErrorMessage(err)}`));
    });
    this.child.on("exit", (code, signal) => {
      const suffix =
        typeof code === "number" ? `exit ${code}` : signal ? `signal ${signal}` : "unknown exit";
      this.closed = true;
      this.failAllPending(new Error(`[${this.serverName}] process terminated (${suffix})`));
    });
  }

  static async launch(params: {
    serverName: string;
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
  }): Promise<McpStdioClient> {
    try {
      return await McpStdioClient.launchWithFraming({
        ...params,
        framing: "line",
      });
    } catch (lineErr) {
      log.debug(
        "[" +
          params.serverName +
          "] line framing failed, retrying with header framing: " +
          toErrorMessage(lineErr),
      );
      return McpStdioClient.launchWithFraming({
        ...params,
        framing: "header",
      });
    }
  }

  private static async launchWithFraming(params: {
    serverName: string;
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    framing: McpFraming;
  }): Promise<McpStdioClient> {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...params.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const client = new McpStdioClient(params.serverName, params.framing, child);
    try {
      await client.initialize();
      return client;
    } catch (err) {
      try {
        await client.close();
      } catch {
        // Ignore cleanup errors from a failed launch path.
      }
      throw err;
    }
  }

  private failAllPending(err: Error) {
    if (this.pending.size === 0) {
      return;
    }
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.abortCleanup?.();
      pending.reject(new Error(`[id ${id}] ${err.message}`));
    }
    this.pending.clear();
  }

  private handleStdoutChunk(chunk: Buffer) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    if (this.framing === "line") {
      this.drainLineDelimitedMessages();
      return;
    }
    this.drainHeaderDelimitedMessages();
  }

  private drainLineDelimitedMessages() {
    while (true) {
      const lineEnd = this.stdoutBuffer.indexOf("\n");
      if (lineEnd < 0) {
        return;
      }

      const rawLine = this.stdoutBuffer.subarray(0, lineEnd).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(lineEnd + 1);
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.handleJsonRpcMessage(message);
      } catch (err) {
        log.warn(
          "[" +
            this.serverName +
            "] failed to parse line-delimited JSON-RPC message: " +
            toErrorMessage(err),
        );
      }
    }
  }

  private drainHeaderDelimitedMessages() {
    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const headerText = this.stdoutBuffer.subarray(0, headerEnd).toString("utf8");
      const contentLengthMatch = headerText.match(/content-length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1] ?? "", 10);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEnd + 4);
        continue;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.stdoutBuffer.length < bodyEnd) {
        return;
      }

      const body = this.stdoutBuffer.subarray(bodyStart, bodyEnd);
      this.stdoutBuffer = this.stdoutBuffer.subarray(bodyEnd);

      try {
        const message = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        this.handleJsonRpcMessage(message);
      } catch (err) {
        log.warn(
          "[" +
            this.serverName +
            "] failed to parse header-delimited JSON-RPC message: " +
            toErrorMessage(err),
        );
      }
    }
  }
  private handleJsonRpcMessage(message: Record<string, unknown>) {
    const idValue = message.id;
    if (typeof idValue !== "number") {
      return;
    }

    const pending = this.pending.get(idValue);
    if (!pending) {
      return;
    }
    this.pending.delete(idValue);
    clearTimeout(pending.timeout);
    pending.abortCleanup?.();

    if (isPlainObject(message.error)) {
      const code = message.error.code;
      const errorMessage = message.error.message;
      const suffix = typeof code === "number" ? ` (${code})` : "";
      const text = typeof errorMessage === "string" ? errorMessage : "Unknown MCP error";
      pending.reject(new Error(`[${this.serverName}] ${text}${suffix}`));
      return;
    }

    pending.resolve(message.result);
  }

  private sendMessage(payload: Record<string, unknown>) {
    if (this.closed || this.child.stdin.destroyed) {
      throw new Error(`[${this.serverName}] stdin is not writable`);
    }

    const bodyText = JSON.stringify(payload);
    if (this.framing === "line") {
      this.child.stdin.write(`${bodyText}\n`);
      return;
    }

    const body = Buffer.from(bodyText, "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    const frame = Buffer.concat([header, body]);
    this.child.stdin.write(frame);
  }

  private sendNotification(method: string, params?: Record<string, unknown>) {
    this.sendMessage({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
  }

  private async request(params: {
    method: string;
    payload?: Record<string, unknown>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    if (this.closed) {
      throw new Error(`[${this.serverName}] client is closed`);
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`[${this.serverName}] request timeout: ${params.method}`));
        },
        Math.max(1, params.timeoutMs),
      );

      const cleanup = () => {
        params.signal?.removeEventListener?.("abort", onAbort);
      };

      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`[${this.serverName}] request aborted: ${params.method}`));
      };

      if (params.signal?.aborted) {
        onAbort();
        return;
      }
      params.signal?.addEventListener?.("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
        abortCleanup: cleanup,
      });

      try {
        this.sendMessage({
          jsonrpc: "2.0",
          id,
          method: params.method,
          ...(params.payload ? { params: params.payload } : {}),
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timeout);
        cleanup();
        reject(
          new Error(`[${this.serverName}] failed to send ${params.method}: ${toErrorMessage(err)}`),
        );
      }
    });
  }

  private async initialize() {
    await this.request({
      method: "initialize",
      payload: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "openclaw",
          version: "2026.2.16",
        },
      },
      timeoutMs: MCP_INIT_TIMEOUT_MS,
    });
    this.sendNotification("notifications/initialized");
  }

  async listTools(): Promise<McpToolListEntry[]> {
    const result = await this.request({
      method: "tools/list",
      payload: {},
      timeoutMs: MCP_LIST_TIMEOUT_MS,
    });
    if (!isPlainObject(result) || !Array.isArray(result.tools)) {
      return [];
    }

    const tools: McpToolListEntry[] = [];
    for (const tool of result.tools) {
      if (!isPlainObject(tool)) {
        continue;
      }
      const name = typeof tool.name === "string" ? tool.name.trim() : "";
      if (!name) {
        continue;
      }
      tools.push({
        name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: tool.inputSchema,
      });
    }
    return tools;
  }

  async callTool(params: {
    name: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown> {
    return this.request({
      method: "tools/call",
      payload: {
        name: params.name,
        arguments: params.args,
      },
      timeoutMs: MCP_CALL_TIMEOUT_MS,
      signal: params.signal,
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      await this.request({
        method: "shutdown",
        payload: {},
        timeoutMs: MCP_SHUTDOWN_TIMEOUT_MS,
      });
    } catch {
      // Best effort; continue shutdown path.
    }

    try {
      this.sendNotification("exit");
    } catch {
      // Ignore write errors if process already exited.
    }

    this.closed = true;

    try {
      this.child.stdin.end();
    } catch {
      // Ignore close errors.
    }

    const exitedQuickly = await Promise.race([
      once(this.child, "exit").then(() => true),
      delay(MCP_EXIT_GRACE_MS).then(() => false),
    ]);
    if (!exitedQuickly) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Ignore kill errors.
      }
      await Promise.race([once(this.child, "exit").then(() => true), delay(MCP_EXIT_GRACE_MS)]);
      if (!this.child.killed) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Ignore final kill errors.
        }
      }
    }
  }
}

function buildUniqueToolName(params: {
  serverName: string;
  remoteToolName: string;
  usedNames: Set<string>;
}): string {
  const serverPart = normalizeMcpToolNameSegment(params.serverName);
  const toolPart = normalizeMcpToolNameSegment(params.remoteToolName);
  const baseRaw = `mcp_${serverPart}_${toolPart}`;
  const base = baseRaw.slice(0, MCP_TOOL_NAME_MAX_LENGTH);

  const lowerBase = base.toLowerCase();
  if (!params.usedNames.has(lowerBase)) {
    params.usedNames.add(lowerBase);
    return base;
  }

  for (let i = 2; i < 10_000; i += 1) {
    const suffix = `_${i}`;
    const head = base.slice(0, Math.max(1, MCP_TOOL_NAME_MAX_LENGTH - suffix.length));
    const candidate = `${head}${suffix}`;
    const lowerCandidate = candidate.toLowerCase();
    if (!params.usedNames.has(lowerCandidate)) {
      params.usedNames.add(lowerCandidate);
      return candidate;
    }
  }

  const fallback = `${base.slice(0, MCP_TOOL_NAME_MAX_LENGTH - 2)}_x`;
  params.usedNames.add(fallback.toLowerCase());
  return fallback;
}

export async function createEmbeddedMcpTools(params: {
  workspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
}): Promise<EmbeddedMcpToolHandle> {
  const specs = resolveSnapshotMcpServers(params.skillsSnapshot);
  if (specs.length === 0) {
    return {
      tools: [],
      cleanup: async () => {},
    };
  }

  const clients: McpStdioClient[] = [];
  const tools: AnyAgentTool[] = [];
  const usedToolNames = new Set<string>();

  for (const spec of specs) {
    try {
      const client = await McpStdioClient.launch({
        serverName: spec.name,
        command: spec.command,
        args: spec.args,
        cwd: params.workspaceDir,
        env: spec.env,
      });
      clients.push(client);

      const listedTools = await client.listTools();
      if (listedTools.length === 0) {
        log.debug(`[${spec.name}] no tools returned by MCP server`);
      }
      for (const entry of listedTools) {
        const toolName = buildUniqueToolName({
          serverName: spec.name,
          remoteToolName: entry.name,
          usedNames: usedToolNames,
        });
        tools.push({
          name: toolName,
          label: `${spec.name}.${entry.name}`,
          description:
            entry.description?.trim() || `MCP tool ${entry.name} exposed by server ${spec.name}.`,
          parameters: normalizeMcpToolSchema(entry.inputSchema),
          execute: async (_toolCallId, args, signal) => {
            if (!isPlainObject(args)) {
              throw new Error(`MCP tool ${toolName} expects an object argument payload.`);
            }
            const result = await client.callTool({
              name: entry.name,
              args,
              signal,
            });
            return jsonResult({
              status: "ok",
              mcp: {
                server: spec.name,
                tool: entry.name,
              },
              result,
            });
          },
        });
      }
    } catch (err) {
      log.warn(`[${spec.name}] MCP server unavailable: ${toErrorMessage(err)}`);
    }
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    for (const client of clients.toReversed()) {
      try {
        await client.close();
      } catch (err) {
        log.warn(`MCP cleanup failed: ${toErrorMessage(err)}`);
      }
    }
  };

  return { tools, cleanup };
}
