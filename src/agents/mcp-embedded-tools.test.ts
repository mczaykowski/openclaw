import { describe, expect, it } from "vitest";
import {
  normalizeMcpToolCallResult,
  recoverMcpToolCallResultFromError,
} from "./mcp-embedded-tools.js";

describe("normalizeMcpToolCallResult", () => {
  it("returns the same object for already-compliant content blocks", () => {
    const input = {
      content: [{ type: "text", text: "ok" }],
      isError: false,
    };

    const result = normalizeMcpToolCallResult(input);

    expect(result).toBe(input);
  });

  it("normalizes object text payloads into strings", () => {
    const input = {
      content: [{ type: "text", text: { status: "ok", count: 2 } }],
    };

    const result = normalizeMcpToolCallResult(input) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).not.toBe(input);
    expect(result.content[0]?.type).toBe("text");
    expect(typeof result.content[0]?.text).toBe("string");
    expect(result.content[0]?.text).toContain('"status": "ok"');
  });

  it("normalizes string content to a text content block", () => {
    const result = normalizeMcpToolCallResult({ content: "plain text" }) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content).toEqual([{ type: "text", text: "plain text" }]);
  });

  it("normalizes unknown content block shapes into text blocks", () => {
    const result = normalizeMcpToolCallResult({
      content: [{ foo: "bar" }, 42],
    }) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain('"foo": "bar"');
    expect(result.content[1]).toEqual({ type: "text", text: "42" });
  });
});

describe("recoverMcpToolCallResultFromError", () => {
  it("recovers a tools/call result from -32602 error data", () => {
    const recovery = recoverMcpToolCallResultFromError({
      code: -32602,
      message: "Invalid tools/call result",
      data: {
        result: {
          content: [{ type: "text", text: { hello: "world" } }],
        },
      },
    });

    expect(recovery.recovered).toBe(true);
    const result = recovery.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toContain('"hello": "world"');
  });

  it("does not recover unrelated errors", () => {
    const recovery = recoverMcpToolCallResultFromError({
      code: -32000,
      message: "server blew up",
      data: { result: { content: [{ type: "text", text: { a: 1 } }] } },
    });

    expect(recovery).toEqual({ recovered: false });
  });
});
