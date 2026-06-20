import { describeEval } from "vitest-evals";
import { assertValidResponseOutcome } from "../tests/support/outcomes";
import { incidentTriageHarness } from "./harness";
import { RecommendationQualityJudge } from "./judges";

describeEval(
  "incident triage recommendation quality",
  {
    harness: incidentTriageHarness,
    judges: [RecommendationQualityJudge],
    judgeThreshold: null,
  },
  (it) => {
    it.for([
      { name: "dependency outage recommendation is grounded", input: { scenarioName: "checkout-payment-timeout" } },
      { name: "bad deploy recommendation is grounded", input: { scenarioName: "bad-deploy-latency" } },
      { name: "capacity recommendation is grounded", input: { scenarioName: "capacity-saturation" } },
    ])("$name", async ({ input }, { run }) => {
      const result = await run(input);

      assertValidResponseOutcome(result.output, {
        evidencePrefixes: ["alert:"],
        requireSafety: true,
      });
    });
  },
);
