import { main } from "../src/cli";
import { operatorDemoPreflight, operatorDemoStartupMessage } from "./operator-demo-preflight";

const preflight = await operatorDemoPreflight();
if (!preflight.ok) {
  console.error(preflight.message);
  process.exitCode = 2;
} else {
  process.env.AI_OPERATOR_MODE = "local";
  process.env.GRAFANA_WEBHOOK_SECRET ||= "local-secret";
  process.env.OPERATOR_READ_TOKEN = "";

  console.error(operatorDemoStartupMessage());
  const code = await main(["serve", "--mock-llm"]);
  process.exitCode = code;
}
