import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";

async function withTempConfig(params: { cfg: unknown; run: () => Promise<void> }): Promise<void> {
  const prevConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const prevDisableCache = process.env.OPENCLAW_DISABLE_CONFIG_CACHE;

  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-control-ui-auth-test-"));
  const configPath = path.join(dir, "openclaw.json");

  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_DISABLE_CONFIG_CACHE = "1";

  try {
    await writeFile(configPath, JSON.stringify(params.cfg, null, 2), "utf-8");
    await params.run();
  } finally {
    if (prevConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = prevConfigPath;
    }
    if (prevDisableCache === undefined) {
      delete process.env.OPENCLAW_DISABLE_CONFIG_CACHE;
    } else {
      process.env.OPENCLAW_DISABLE_CONFIG_CACHE = prevDisableCache;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function createRequest(params: {
  path: string;
  remoteAddress: string;
  authorization?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: "localhost:18789",
  };
  if (params.authorization) {
    headers.authorization = params.authorization;
  }
  return {
    method: "GET",
    url: params.path,
    headers,
    socket: { remoteAddress: params.remoteAddress },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
} {
  let body = "";
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: unknown) => {
      if (typeof chunk === "string") {
        body = chunk;
        return;
      }
      if (chunk == null) {
        body = "";
        return;
      }
      body = JSON.stringify(chunk);
    },
  } as unknown as ServerResponse;

  return { res, getBody: () => body };
}

async function dispatchRequest(
  server: ReturnType<typeof createGatewayHttpServer>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  server.emit("request", req, res);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("gateway control UI auth guardrail", () => {
  test("requires gateway auth for non-local control UI requests", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });

        const res = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/__control__/", remoteAddress: "203.0.113.10" }),
          res.res,
        );

        expect(res.res.statusCode).toBe(401);
        expect(res.getBody()).toContain("Unauthorized");
      },
    });
  });

  test("forbids non-local control UI requests when gateway auth mode is none", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });

        const res = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/__control__/", remoteAddress: "203.0.113.10" }),
          res.res,
        );

        expect(res.res.statusCode).toBe(403);
        expect(res.getBody()).toContain("Forbidden");
      },
    });
  });
});
