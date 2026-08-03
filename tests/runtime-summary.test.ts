import { expect, test } from "vitest";
import { runtimeSummary } from "../src/runtime-summary";

test("runtime summary identifies the Node TypeScript path", () => {
  expect(runtimeSummary()).toEqual({
    runtime: "node",
    status: "typescript runtime ready",
  });
});

test("runtime summary can include operator mode capabilities", () => {
  expect(runtimeSummary({
    mode: "read_only",
    capabilities: {
      readOnlyTriage: true,
      approvalStaging: false,
      execution: false,
    },
    redacted: {
      AI_OPERATOR_MODE: "read_only",
    },
  })).toMatchObject({
    operatorMode: "read_only",
    capabilities: {
      readOnlyTriage: true,
      approvalStaging: false,
      execution: false,
    },
  });
});
