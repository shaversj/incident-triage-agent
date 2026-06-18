import { expect, test } from "vitest";
import { runtimeSummary } from "../src/runtime-summary";

test("runtime summary identifies the Node TypeScript path", () => {
  expect(runtimeSummary()).toEqual({
    runtime: "node",
    status: "typescript runtime ready",
  });
});
