import { randomUUID } from "node:crypto";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { agentCommand } from "../commands/agent.js";
import { loadConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  loadSessionEntry,
  pruneLegacyStoreKeys,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;

function toStringOrEmpty(val: unknown): string {
  if (typeof val === "string") {
    return val.trim();
  }
  return "";
}

function compactExecEventOutput(raw: string) {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_EXEC_EVENT_OUTPUT_CHARS) {
    return normalized;
  }
  const safe = Math.max(1, MAX_EXEC_EVENT_OUTPUT_CHARS - 1);
  return `${normalized.slice(0, safe)}…`;
}

type LoadedSessionEntry = ReturnType<typeof loadSessionEntry>;

async function touchSessionStore(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  entry: LoadedSessionEntry["entry"];
  sessionId: string;
  now: number;
}) {
  const { storePath } = params;
  if (!storePath) {
    return;
  }
  await updateSessionStore(storePath, (store) => {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.sessionKey,
      store,
    });
    pruneLegacyStoreKeys({
      store,
      canonicalKey: target.canonicalKey,
      candidates: target.storeKeys,
    });
    store[params.canonicalKey] = {
      sessionId: params.sessionId,
      updatedAt: params.now,
      thinkingLevel: params.entry?.thinkingLevel,
      verboseLevel: params.entry?.verboseLevel,
      reasoningLevel: params.entry?.reasoningLevel,
      systemSent: params.entry?.systemSent,
      sendPolicy: params.entry?.sendPolicy,
      lastChannel: params.entry?.lastChannel,
      lastTo: params.entry?.lastTo,
    };
  });
}

export const handleNodeEvent = async (ctx: NodeEventContext, nodeId: string, evt: NodeEvent) => {
  const event = evt.event;
  let p: Record<string, unknown> = {};
  if (evt.payloadJSON) {
    try {
      const parsed = JSON.parse(evt.payloadJSON);
      if (typeof parsed === "object" && parsed !== null) {
        p = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  const sessionKey = toStringOrEmpty(p.sessionKey);
  const nodeIdForLog = nodeId || "unknown-node";

  // Security: check if the node is authorized to interact with the session.
  // Standard nodes are restricted to their own "node-${nodeId}" sessions unless
  // they have "operator.admin" or "operator.write" scopes.
  if (event === "voice.transcript" || event === "agent.request" || event === "chat.subscribe") {
    if (!ctx.isNodeAuthorizedForSession(nodeId, sessionKey)) {
      ctx.logGateway.warn(
        `node.event: unauthorized node=${nodeIdForLog} event=${event} session=${sessionKey}`,
      );
      return;
    }
  }

  if (event === "voice.transcript") {
    const text = toStringOrEmpty(p.text);
    if (!text) {
      return;
    }
    if (text.length > 20_000) {
      return;
    }

    const cfg = loadConfig();
    const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
    const resolvedSessionKey = sessionKey.length > 0 ? sessionKey : rawMainKey;
    const { storePath, entry, canonicalKey } = loadSessionEntry(resolvedSessionKey);
    const now = Date.now();
    const sessionId = entry?.sessionId ?? randomUUID();
    await touchSessionStore({
      cfg,
      sessionKey: resolvedSessionKey,
      storePath,
      canonicalKey,
      entry,
      sessionId,
      now,
    });

    // Ensure chat UI clients refresh when this run completes (even though it wasn't started via chat.send).
    // This maps agent bus events (keyed by sessionId) to chat events (keyed by clientRunId).
    ctx.addChatRun(sessionId, {
      sessionKey: canonicalKey,
      clientRunId: `voice-${randomUUID()}`,
    });

    void agentCommand(
      {
        message: text,
        sessionId,
        sessionKey: canonicalKey,
        thinking: "low",
        deliver: false,
        messageChannel: "node",
      },
      defaultRuntime,
      ctx.deps,
    ).catch((err) => {
      ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
    });
    return;
  }

  if (event === "agent.request") {
    const message = toStringOrEmpty(p.message);
    if (!message) {
      return;
    }
    if (message.length > 20_000) {
      return;
    }

    const channelRaw = toStringOrEmpty(p.channel);
    const channel = normalizeChannelId(channelRaw) ?? undefined;
    const to = toStringOrEmpty(p.to) || undefined;
    const deliver = Boolean(p.deliver) && Boolean(channel);

    const cfg = loadConfig();
    const resolvedSessionKey = sessionKey.length > 0 ? sessionKey : `node-${nodeId}`;
    const { storePath, entry, canonicalKey } = loadSessionEntry(resolvedSessionKey);
    const now = Date.now();
    const sessionId = entry?.sessionId ?? randomUUID();
    await touchSessionStore({
      cfg,
      sessionKey: resolvedSessionKey,
      storePath,
      canonicalKey,
      entry,
      sessionId,
      now,
    });

    void agentCommand(
      {
        message,
        sessionId,
        sessionKey: canonicalKey,
        thinking: toStringOrEmpty(p.thinking) || undefined,
        deliver,
        to,
        channel,
        timeout: typeof p.timeoutSeconds === "number" ? p.timeoutSeconds.toString() : undefined,
        messageChannel: "node",
      },
      defaultRuntime,
      ctx.deps,
    ).catch((err) => {
      ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
    });
    return;
  }

  if (event === "chat.subscribe") {
    if (!sessionKey) {
      return;
    }
    ctx.nodeSubscribe(nodeId, sessionKey);
    return;
  }

  if (event === "chat.unsubscribe") {
    if (!sessionKey) {
      return;
    }
    ctx.nodeUnsubscribe(nodeId, sessionKey);
    return;
  }

  if (event === "voice.wake.changed") {
    const triggers = Array.isArray(p.triggers) ? (p.triggers as string[]) : [];
    ctx.broadcastVoiceWakeChanged(triggers);
    return;
  }

  switch (event) {
    case "exec.started":
    case "exec.finished":
    case "exec.denied": {
      const sessionKeyForExec = sessionKey || `node-${nodeId}`;
      const runId = toStringOrEmpty(p.runId);
      const command = toStringOrEmpty(p.command);
      const exitCode =
        typeof p.exitCode === "number" && Number.isFinite(p.exitCode) ? p.exitCode : undefined;
      const timedOut = p.timedOut === true;
      const output = toStringOrEmpty(p.output);
      const reason = toStringOrEmpty(p.reason);

      let text = "";
      if (event === "exec.started") {
        text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      } else if (event === "exec.finished") {
        const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
        const compactOutput = compactExecEventOutput(output);
        const shouldNotify = timedOut || exitCode !== 0 || compactOutput.length > 0;
        if (!shouldNotify) {
          return;
        }
        text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
        if (compactOutput) {
          text += `\n${compactOutput}`;
        }
      } else {
        text = `Exec denied (node=${nodeId}${runId ? ` id=${runId}` : ""}${reason ? `, ${reason}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      }

      enqueueSystemEvent(text, {
        sessionKey: sessionKeyForExec,
        contextKey: runId ? `exec:${runId}` : "exec",
      });
      requestHeartbeatNow({ reason: "exec-event" });
      return;
    }
    default:
      return;
  }
};
