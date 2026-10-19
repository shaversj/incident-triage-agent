import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";

import type { OperatorMode } from "../config";
import type { WebhookRuntime } from "./contracts";

const maxRequestBodyBytes = 1_000_000;

export function runtimeMode(runtime: WebhookRuntime): OperatorMode {
  return runtime.mode ?? "local";
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxRequestBodyBytes) {
        if (!rejected) {
          rejected = true;
          reject(new Error("request body too large"));
        }
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks, totalBytes).toString("utf8"));
      }
    });
    request.on("error", (error) => {
      if (!rejected) {
        rejected = true;
        reject(error);
      }
    });
  });
}

export function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
  });
  response.end(encoded);
}

export function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function numberQueryParam(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function requiredBodyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function operatorReadAuthorized(headers: IncomingHttpHeaders, runtime: WebhookRuntime): boolean {
  if (!runtime.operatorReadToken) {
    return runtimeMode(runtime) === "local";
  }
  return firstHeader(headers.authorization) === `Bearer ${runtime.operatorReadToken}`;
}

export function operatorWriteAuthorized(request: IncomingMessage, runtime: WebhookRuntime): boolean {
  if (runtime.operatorWriteToken) {
    return firstHeader(request.headers.authorization) === `Bearer ${runtime.operatorWriteToken}`;
  }
  return runtimeMode(runtime) === "local" && isLoopbackAddress(request.socket.remoteAddress);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
