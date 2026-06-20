import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { incidentClasses, nextActions } from "../src/domain";
import { assertValidResponseOutcome } from "../tests/support/outcomes";
import { incidentTriageHarness, liveEvalEnabled } from "./harness";

describeEval(
  "incident triage live Flue/MiniMax drift",
  { harness: incidentTriageHarness, skipIf: () => !liveEvalEnabled() },
  (it) => {
    it.for([
      {
        name: "live checkout keeps bounded grounded decision",
        scenarioName: "checkout-payment-timeout",
        evidencePrefixes: ["alert:", "log:"],
      },
      {
        name: "live capacity keeps approval-sensitive safety behavior",
        scenarioName: "capacity-saturation",
        evidencePrefixes: ["alert:", "log:"],
      },
      {
        name: "live bad deploy keeps deployment evidence in play",
        scenarioName: "bad-deploy-latency",
        evidencePrefixes: ["alert:", "deploy:", "log:"],
      },
      {
        name: "live noisy alert stays bounded and non-mutating or context-seeking",
        scenarioName: "noisy-alert",
        evidencePrefixes: ["alert:"],
      },
    ])("$name", async ({ scenarioName, evidencePrefixes }, { run }) => {
      const result = await run({ scenarioName, mode: "live" });

      assertValidResponseOutcome(result.output, {
        evidencePrefixes,
        citedTiers: ["current_signal"],
        requireSafety: true,
      });
      expect(incidentClasses).toContain((result.output.decision as any).incident_class);
      expect(nextActions).toContain((result.output.decision as any).next_action);
      expect((result.output.safety as any).audit_event?.executed).not.toBe(true);
    });
  },
);
