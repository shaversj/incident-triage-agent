import type { OperatorModeConfig } from "./config";

export interface RuntimeSummary {
  runtime: "node";
  status: string;
  operatorMode?: OperatorModeConfig["mode"];
  capabilities?: OperatorModeConfig["capabilities"];
}

export function runtimeSummary(operator?: OperatorModeConfig): RuntimeSummary {
  const summary: RuntimeSummary = {
    runtime: "node",
    status: "typescript runtime ready",
  };
  if (operator) {
    summary.operatorMode = operator.mode;
    summary.capabilities = operator.capabilities;
  }
  return summary;
}
