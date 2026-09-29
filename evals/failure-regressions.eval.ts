import { expect } from "vitest";
import { createHarness, describeEval, toJsonValue, type JsonValue } from "vitest-evals";
import {
  failureRegressionCases,
  validateFailureRegressionRegistry,
} from "./failure-regressions";
import { runIncidentTriage } from "./incident-triage-runner";

type RegressionOutput = Record<string, JsonValue>;

const failureRegressionHarness = createHarness<string, RegressionOutput>({
  name: "failure-regression-workflow",
  run: async ({ input: regressionId, setArtifact }) => {
    const registryErrors = validateFailureRegressionRegistry(failureRegressionCases);
    if (registryErrors.length > 0) {
      throw new Error(`Failure regression registry is invalid: ${registryErrors.join(" ")}`);
    }
    const regression = failureRegressionCases.find((item) => item.id === regressionId);
    if (!regression) {
      throw new Error(`Unknown failure regression ${regressionId}.`);
    }
    const result = await runIncidentTriage(regression.input);
    setArtifact("failure_provenance", {
      regression_id: regression.id,
      failure_mode_id: regression.failureMode.id,
      failure_mode_revision: regression.failureMode.revision,
      source_case_ids: regression.sourceCaseIds,
    });
    const output = toJsonValue(result.output) as RegressionOutput;
    return {
      output,
      metadata: {
        scenario: regression.input.scenarioName,
        mode: regression.input.mode ?? "mock",
        run_status: output.run_status,
        regression_id: regression.id,
        failure_mode_id: regression.failureMode.id,
        failure_mode_revision: regression.failureMode.revision,
        source_case_ids: regression.sourceCaseIds,
      },
    };
  },
});

describeEval("failure discovery regressions", { harness: failureRegressionHarness }, (it) => {
  it("registry provenance resolves before execution", () => {
    expect(validateFailureRegressionRegistry(failureRegressionCases)).toEqual([]);
  });

  it.for(failureRegressionCases.map((regression) => ({
    name: regression.name,
    input: regression.id,
    regression,
  })))("$name", async ({ input, regression }, { run }) => {
    const result = await run(input);

    expect(() => regression.assert(result.output)).not.toThrow();
  });
});
