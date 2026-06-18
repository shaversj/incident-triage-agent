import { expect, test } from "bun:test";
import { runtimeSummary } from "../src/runtime-summary";

test("runtime scaffold identifies the Bun TypeScript path", () => {
  expect(runtimeSummary()).toEqual({
    runtime: "bun",
    status: "typescript scaffold ready",
  });
});
