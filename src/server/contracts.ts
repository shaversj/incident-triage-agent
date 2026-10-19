import type { Server } from "node:http";

import type { OperatorMode } from "../config";
import type { LLMDecisionClient } from "../llm";
import type { LokiClientLike } from "../loki";
import type { TriageLogger } from "../logger";
import type { TriageRunPersistenceStore } from "../persistence/contracts";
import type { EvidenceMaterialityClassifier } from "../reentry";

export interface WebhookRuntime {
  fixturesDir: string;
  webhookSecret: string;
  llmClient: LLMDecisionClient;
  lokiClient?: LokiClientLike;
  lokiLimit: number;
  mode?: OperatorMode;
  runStore?: TriageRunPersistenceStore;
  operatorReadToken?: string;
  operatorWriteToken?: string;
  operatorWriteActor?: string;
  hmacToleranceMs?: number;
  replayTtlMs?: number;
  retentionCleanupIntervalMs?: number;
  approvalStorePath?: string;
  materialityClassifier?: EvidenceMaterialityClassifier;
}

export interface WebhookServerOptions {
  host: string;
  port: number;
  runtime: WebhookRuntime;
  logger?: TriageLogger;
}

export interface RunningWebhookServer {
  server: Server;
  ready: Promise<void>;
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface HandleGrafanaWebhookOptions {
  bodyDigest?: string;
}
