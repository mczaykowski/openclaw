import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { TypingController } from "./typing.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { buildTestCtx } from "./test-ctx.js";

const handleCommandsMock = vi.fn();
const createOpenClawToolsMock = vi.fn();
const toolExecuteMock = vi.fn();

vi.mock("../../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (...args: unknown[]) => createOpenClawToolsMock(...args),
}));

vi.mock("./commands.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  buildStatusReply: vi.fn(),
  buildCommandContext: vi.fn(),
}));

const { handleInlineActions } = await import("./get-reply-inline-actions.js");

function makeTyping(): TypingController {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

describe("handleInlineActions exact JSON tool call", () => {
  it("executes exact tool call with parsed object args", async () => {
    handleCommandsMock.mockReset();
    createOpenClawToolsMock.mockReset();
    toolExecuteMock.mockReset();

    toolExecuteMock.mockResolvedValue({
      content: [{ type: "text", text: '{"status":"ok"}' }],
    });
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "subagents",
        execute: toolExecuteMock,
      },
    ]);

    const body = `Call subagents with this JSON arguments exactly:\n{\n  "action": "list",\n  "recentMinutes": 60\n}\nReturn only the tool result JSON.`;

    const typing = makeTyping();
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      From: "matrix:@owner:example.com",
      To: "matrix:@zed:example.com",
      Provider: "matrix",
      Surface: "matrix",
      CommandAuthorized: true,
    });

    const result = await handleInlineActions({
      ctx,
      sessionCtx: ctx as unknown as TemplateContext,
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp",
      isGroup: false,
      typing,
      allowTextCommands: true,
      inlineStatusRequested: false,
      command: {
        surface: "matrix",
        channel: "matrix",
        channelId: "matrix",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        senderId: "@owner:example.com",
        abortKey: "matrix:@owner:example.com",
        rawBodyNormalized: body,
        commandBodyNormalized: body,
        from: "matrix:@owner:example.com",
        to: "matrix:@zed:example.com",
      },
      directives: clearInlineDirectives(body),
      cleanedBody: body,
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: () => ({ enabled: true, message: "" }),
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: undefined,
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      resolveDefaultThinkingLevel: async () => "off",
      provider: "minimax",
      model: "MiniMax-M2.5",
      contextTokens: 0,
      abortedLastRun: false,
      sessionScope: "per-sender",
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: '{"status":"ok"}' },
    });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(toolExecuteMock).toHaveBeenCalledTimes(1);
    expect(toolExecuteMock.mock.calls[0]?.[1]).toEqual({
      action: "list",
      recentMinutes: 60,
    });
    expect(typing.cleanup).toHaveBeenCalled();
  });

  it("returns parse error for malformed JSON", async () => {
    handleCommandsMock.mockReset();
    createOpenClawToolsMock.mockReset();
    toolExecuteMock.mockReset();

    createOpenClawToolsMock.mockReturnValue([]);

    const body = `Call subagents with this JSON arguments exactly:\n{\n  "action": "list",\n  "recentMinutes":\n}\nReturn only the tool result JSON.`;

    const typing = makeTyping();
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      From: "matrix:@owner:example.com",
      To: "matrix:@zed:example.com",
      Provider: "matrix",
      Surface: "matrix",
      CommandAuthorized: true,
    });

    const result = await handleInlineActions({
      ctx,
      sessionCtx: ctx as unknown as TemplateContext,
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp",
      isGroup: false,
      typing,
      allowTextCommands: true,
      inlineStatusRequested: false,
      command: {
        surface: "matrix",
        channel: "matrix",
        channelId: "matrix",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        senderId: "@owner:example.com",
        abortKey: "matrix:@owner:example.com",
        rawBodyNormalized: body,
        commandBodyNormalized: body,
        from: "matrix:@owner:example.com",
        to: "matrix:@zed:example.com",
      },
      directives: clearInlineDirectives(body),
      cleanedBody: body,
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: () => ({ enabled: true, message: "" }),
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: undefined,
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      resolveDefaultThinkingLevel: async () => "off",
      provider: "minimax",
      model: "MiniMax-M2.5",
      contextTokens: 0,
      abortedLastRun: false,
      sessionScope: "per-sender",
    });

    expect(result.kind).toBe("reply");
    expect((result.reply as { text?: string })?.text).toMatch(/^❌ Invalid JSON:/);
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(toolExecuteMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalled();
  });
});
