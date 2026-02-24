import type { SkillCommandSpec } from "../../agents/skills.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.js";
import type { createModelSelectionState } from "./model-selection.js";
import type { TypingController } from "./typing.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.js";
import { getChannelDock } from "../../channels/dock.js";
import { logVerbose } from "../../globals.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import { listChatCommands } from "../commands-registry.js";
import { listSkillCommandsForWorkspace, resolveSkillCommandInvocation } from "../skill-commands.js";
import { getAbortMemory } from "./abort.js";
import { buildStatusReply, handleCommands } from "./commands.js";
import { isDirectiveOnly } from "./directive-handling.js";
import { extractInlineSimpleCommand } from "./reply-inline.js";

const builtinSlashCommands = (() => {
  const reserved = new Set<string>();
  for (const command of listChatCommands()) {
    if (command.nativeName) {
      reserved.add(command.nativeName.toLowerCase());
    }
    for (const alias of command.textAliases) {
      const trimmed = alias.trim();
      if (!trimmed.startsWith("/")) {
        continue;
      }
      reserved.add(trimmed.slice(1).toLowerCase());
    }
  }
  for (const name of [
    "think",
    "verbose",
    "reasoning",
    "elevated",
    "exec",
    "model",
    "status",
    "queue",
  ]) {
    reserved.add(name);
  }
  return reserved;
})();

function resolveSlashCommandName(commandBodyNormalized: string): string | null {
  const trimmed = commandBodyNormalized.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const match = trimmed.match(/^\/([^\s:]+)(?::|\s|$)/);
  const name = match?.[1]?.trim().toLowerCase() ?? "";
  return name ? name : null;
}

export type InlineActionResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | {
      kind: "continue";
      directives: InlineDirectives;
      abortedLastRun: boolean;
    };

// oxlint-disable-next-line typescript/no-explicit-any
function extractTextFromToolResult(result: any): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  const out = parts.join("");
  const trimmed = out.trim();
  return trimmed ? trimmed : null;
}

const EXACT_TOOL_CALL_HEADER_RE =
  /(?:^|\n)\s*call\s+([a-zA-Z0-9_.:-]+)\s+with(?:\s+this)?\s+json(?:\s+arguments?)?(?:\s+exactly)?\s*:/i;
const EXACT_TOOL_CALL_TRAILING_RE = /^return\s+only\s+the\s+tool\s+result\s+json\.?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractJsonObjectWithRemainder(
  body: string,
): { ok: true; jsonText: string; trailing: string } | { ok: false; error: string } {
  const start = body.indexOf("{");
  if (start < 0) {
    return { ok: false, error: "Missing JSON object body after header." };
  }
  const prefix = body.slice(0, start).trim();
  if (prefix.length > 0) {
    return { ok: false, error: "Unexpected text before JSON object." };
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          ok: true,
          jsonText: body.slice(start, i + 1),
          trailing: body.slice(i + 1),
        };
      }
      continue;
    }
  }

  return { ok: false, error: "Unterminated JSON object." };
}

function parseExactToolCallRequest(
  body: string,
):
  | { matched: false }
  | { matched: true; toolName: string; args: Record<string, unknown> }
  | { matched: true; error: string } {
  const source = body || "";
  const header = source.match(EXACT_TOOL_CALL_HEADER_RE);
  if (!header || header.index === undefined) {
    return { matched: false };
  }

  const toolName = header[1]?.trim();
  if (!toolName) {
    return { matched: true, error: "Tool name is required." };
  }

  const afterHeader = source.slice(header.index + header[0].length);
  const extracted = extractJsonObjectWithRemainder(afterHeader);
  if (!extracted.ok) {
    return { matched: true, error: extracted.error };
  }

  const trailing = extracted.trailing.trim();
  if (trailing.length > 0 && !EXACT_TOOL_CALL_TRAILING_RE.test(trailing)) {
    return {
      matched: true,
      error:
        "Unexpected trailing text after JSON. Keep only the JSON block and optional Return-only line.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { matched: true, error: "Invalid JSON: " + message };
  }

  if (!isRecord(parsed)) {
    return { matched: true, error: "JSON arguments must be an object." };
  }

  return { matched: true, toolName, args: parsed };
}

export async function handleInlineActions(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: Parameters<typeof buildStatusReply>[0]["sessionScope"];
  workspaceDir: string;
  isGroup: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  allowTextCommands: boolean;
  inlineStatusRequested: boolean;
  command: Parameters<typeof handleCommands>[0]["command"];
  skillCommands?: SkillCommandSpec[];
  directives: InlineDirectives;
  cleanedBody: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: Array<{ gate: string; key: string }>;
  defaultActivation: Parameters<typeof buildStatusReply>[0]["defaultGroupActivation"];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  resolveDefaultThinkingLevel: Awaited<
    ReturnType<typeof createModelSelectionState>
  >["resolveDefaultThinkingLevel"];
  provider: string;
  model: string;
  contextTokens: number;
  directiveAck?: ReplyPayload;
  abortedLastRun: boolean;
  skillFilter?: string[];
}): Promise<InlineActionResult> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    directives: initialDirectives,
    cleanedBody: initialCleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun: initialAbortedLastRun,
    skillFilter,
  } = params;

  let directives = initialDirectives;
  let cleanedBody = initialCleanedBody;

  const slashCommandName = resolveSlashCommandName(command.commandBodyNormalized);
  const shouldLoadSkillCommands =
    allowTextCommands &&
    slashCommandName !== null &&
    // `/skill …` needs the full skill command list.
    (slashCommandName === "skill" || !builtinSlashCommands.has(slashCommandName));
  const skillCommands =
    shouldLoadSkillCommands && params.skillCommands
      ? params.skillCommands
      : shouldLoadSkillCommands
        ? listSkillCommandsForWorkspace({
            workspaceDir,
            cfg,
            skillFilter,
          })
        : [];

  const skillInvocation =
    allowTextCommands && skillCommands.length > 0
      ? resolveSkillCommandInvocation({
          commandBodyNormalized: command.commandBodyNormalized,
          skillCommands,
        })
      : null;
  if (skillInvocation) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /${skillInvocation.command.name} from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }

    const dispatch = skillInvocation.command.dispatch;
    if (dispatch?.kind === "tool") {
      const rawArgs = (skillInvocation.args ?? "").trim();
      const channel =
        resolveGatewayMessageChannel(ctx.Surface) ??
        resolveGatewayMessageChannel(ctx.Provider) ??
        undefined;

      const tools = createOpenClawTools({
        agentSessionKey: sessionKey,
        agentChannel: channel,
        agentAccountId: (ctx as { AccountId?: string }).AccountId,
        agentTo: ctx.OriginatingTo ?? ctx.To,
        agentThreadId: ctx.MessageThreadId ?? undefined,
        agentDir,
        workspaceDir,
        config: cfg,
      });

      const tool = tools.find((candidate) => candidate.name === dispatch.toolName);
      if (!tool) {
        typing.cleanup();
        return { kind: "reply", reply: { text: `❌ Tool not available: ${dispatch.toolName}` } };
      }

      const toolCallId = `cmd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      try {
        const result = await tool.execute(toolCallId, {
          command: rawArgs,
          commandName: skillInvocation.command.name,
          skillName: skillInvocation.command.skillName,
          // oxlint-disable-next-line typescript/no-explicit-any
        } as any);
        const text = extractTextFromToolResult(result) ?? "✅ Done.";
        typing.cleanup();
        return { kind: "reply", reply: { text } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        typing.cleanup();
        return { kind: "reply", reply: { text: `❌ ${message}` } };
      }
    }

    const promptParts = [
      `Use the "${skillInvocation.command.skillName}" skill for this request.`,
      skillInvocation.args ? `User input:\n${skillInvocation.args}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    const rewrittenBody = promptParts.join("\n\n");
    ctx.Body = rewrittenBody;
    ctx.BodyForAgent = rewrittenBody;
    sessionCtx.Body = rewrittenBody;
    sessionCtx.BodyForAgent = rewrittenBody;
    sessionCtx.BodyStripped = rewrittenBody;
    cleanedBody = rewrittenBody;
  }

  const exactToolCall = parseExactToolCallRequest(
    cleanedBody || command.commandBodyNormalized || ctx.Body || "",
  );
  if (exactToolCall.matched) {
    if ("error" in exactToolCall) {
      typing.cleanup();
      return { kind: "reply", reply: { text: "❌ " + exactToolCall.error } };
    }

    const channel =
      resolveGatewayMessageChannel(ctx.Surface) ??
      resolveGatewayMessageChannel(ctx.Provider) ??
      undefined;
    const tools = createOpenClawTools({
      agentSessionKey: sessionKey,
      agentChannel: channel,
      agentAccountId: (ctx as { AccountId?: string }).AccountId,
      agentTo: ctx.OriginatingTo ?? ctx.To,
      agentThreadId: ctx.MessageThreadId ?? undefined,
      agentDir,
      workspaceDir,
      config: cfg,
    });

    const tool = tools.find((candidate) => candidate.name === exactToolCall.toolName);
    if (!tool) {
      typing.cleanup();
      return {
        kind: "reply",
        reply: { text: "❌ Tool not available: " + exactToolCall.toolName },
      };
    }

    const toolCallId = "exact_" + Date.now() + "_" + Math.random().toString(16).slice(2);
    try {
      const result = await tool.execute(toolCallId, exactToolCall.args);
      const text = extractTextFromToolResult(result) ?? "✅ Done.";
      typing.cleanup();
      return { kind: "reply", reply: { text } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      typing.cleanup();
      return { kind: "reply", reply: { text: "❌ " + message } };
    }
  }

  const sendInlineReply = async (reply?: ReplyPayload) => {
    if (!reply) {
      return;
    }
    if (!opts?.onBlockReply) {
      return;
    }
    await opts.onBlockReply(reply);
  };

  const inlineCommand =
    allowTextCommands && command.isAuthorizedSender
      ? extractInlineSimpleCommand(cleanedBody)
      : null;
  if (inlineCommand) {
    cleanedBody = inlineCommand.cleaned;
    sessionCtx.Body = cleanedBody;
    sessionCtx.BodyForAgent = cleanedBody;
    sessionCtx.BodyStripped = cleanedBody;
  }

  const handleInlineStatus =
    !isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    }) && inlineStatusRequested;
  if (handleInlineStatus) {
    const inlineStatusReply = await buildStatusReply({
      cfg,
      command,
      sessionEntry,
      sessionKey,
      sessionScope,
      provider,
      model,
      contextTokens,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel,
      isGroup,
      defaultGroupActivation: defaultActivation,
      mediaDecisions: ctx.MediaUnderstandingDecisions,
    });
    await sendInlineReply(inlineStatusReply);
    directives = { ...directives, hasStatusDirective: false };
  }

  const runCommands = (commandInput: typeof command) =>
    handleCommands({
      ctx,
      cfg,
      command: commandInput,
      agentId,
      directives,
      elevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        failures: elevatedFailures,
      },
      sessionEntry,
      previousSessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      defaultGroupActivation: defaultActivation,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel,
      provider,
      model,
      contextTokens,
      isGroup,
      skillCommands,
    });

  if (inlineCommand) {
    const inlineCommandContext = {
      ...command,
      rawBodyNormalized: inlineCommand.command,
      commandBodyNormalized: inlineCommand.command,
    };
    const inlineResult = await runCommands(inlineCommandContext);
    if (inlineResult.reply) {
      if (!inlineCommand.cleaned) {
        typing.cleanup();
        return { kind: "reply", reply: inlineResult.reply };
      }
      await sendInlineReply(inlineResult.reply);
    }
  }

  if (directiveAck) {
    await sendInlineReply(directiveAck);
  }

  const isEmptyConfig = Object.keys(cfg).length === 0;
  const skipWhenConfigEmpty = command.channelId
    ? Boolean(getChannelDock(command.channelId)?.commands?.skipWhenConfigEmpty)
    : false;
  if (
    skipWhenConfigEmpty &&
    isEmptyConfig &&
    command.from &&
    command.to &&
    command.from !== command.to
  ) {
    typing.cleanup();
    return { kind: "reply", reply: undefined };
  }

  let abortedLastRun = initialAbortedLastRun;
  if (!sessionEntry && command.abortKey) {
    abortedLastRun = getAbortMemory(command.abortKey) ?? false;
  }

  const commandResult = await runCommands(command);
  if (!commandResult.shouldContinue) {
    typing.cleanup();
    return { kind: "reply", reply: commandResult.reply };
  }

  return {
    kind: "continue",
    directives,
    abortedLastRun,
  };
}
