import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { approvalConsoleHtml } from "../approval-console";
import { noopLogger, type TriageLogger } from "../logger";
import { runReviewConsoleHtml } from "../run-review-console";
import {
  approvalSurfaceDisabled,
  routeApprovalApi,
  routeApprovalList,
} from "./approval";
import type { RunningWebhookServer, WebhookRuntime, WebhookServerOptions } from "./contracts";
import { closeServer, runtimeMode, writeHtml, writeJson } from "./http";
import { routeIncidentLifecycleApi, routeOutcomeCandidateApi } from "./lifecycle";
import { routeRunReviewApi } from "./run-review";
import { routeDemoScenarioApi, routeGrafanaWebhook } from "./webhook";

export function startWebhookServer(options: WebhookServerOptions): RunningWebhookServer {
  const logger = options.logger ?? noopLogger;
  const retentionCleanup = startRetentionCleanup(options.runtime, logger);
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, options.runtime, logger);
    } catch (error) {
      logger.error(
        { component: "server", error: error instanceof Error ? error.message : String(error) },
        "Unhandled request error",
      );
      writeJson(response, 500, { status: "error", error: "internal_server_error" });
    }
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => server.once("close", resolve));

  const shutdown = () => {
    retentionCleanup.stop();
    void closeServer(server);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return {
    server,
    ready,
    closed,
    close: async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      retentionCleanup.stop();
      await closeServer(server);
    },
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebhookRuntime,
  logger: TriageLogger,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (approvalSurfaceDisabled(runtime, request.method, url.pathname)) {
    writeJson(response, 404, { status: "error", error: "approval_routes_disabled" });
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/approvals")) {
    writeHtml(response, 200, approvalConsoleHtml());
    return;
  }

  if (request.method === "GET" && url.pathname === "/runs") {
    writeHtml(response, 200, runReviewConsoleHtml({ mode: runtimeMode(runtime) }));
    return;
  }

  if (url.pathname === "/api/approvals") {
    if (request.method !== "GET") {
      writeJson(response, 405, { status: "error", error: "method_not_allowed" });
      return;
    }
    routeApprovalList(response, runtime);
    return;
  }

  if (url.pathname.startsWith("/api/approvals/")) {
    await routeApprovalApi(request, response, runtime, url.pathname);
    return;
  }

  if (url.pathname === "/api/demo/scenarios" || url.pathname.startsWith("/api/demo/scenarios/")) {
    await routeDemoScenarioApi(request, response, runtime, url);
    return;
  }

  if (url.pathname === "/api/runs" || url.pathname.startsWith("/api/runs/")) {
    await routeRunReviewApi(request, response, runtime, url);
    return;
  }

  if (url.pathname.startsWith("/api/incidents/")) {
    await routeIncidentLifecycleApi(request, response, runtime, url);
    return;
  }

  if (url.pathname === "/api/outcome-candidates" || url.pathname.startsWith("/api/outcome-candidates/")) {
    await routeOutcomeCandidateApi(request, response, runtime, url);
    return;
  }

  if (request.method === "POST" && request.url === "/webhooks/grafana") {
    await routeGrafanaWebhook(request, response, runtime, logger);
    return;
  }

  writeJson(response, 404, { status: "error", error: "not_found" });
}

function startRetentionCleanup(runtime: WebhookRuntime, logger: TriageLogger): { stop(): void } {
  const cleanupExpired = runtime.runStore?.cleanupExpired.bind(runtime.runStore);
  if (!cleanupExpired) {
    return { stop: () => undefined };
  }
  const cleanup = () => {
    void cleanupExpired()
      .catch((error) => {
        logger.warn({
          component: "server",
          error: error instanceof Error ? error.message : String(error),
        }, "Failed to clean expired triage persistence rows");
      });
  };
  cleanup();
  const interval = setInterval(cleanup, runtime.retentionCleanupIntervalMs ?? 60 * 60 * 1000);
  interval.unref?.();
  return {
    stop: () => clearInterval(interval),
  };
}
