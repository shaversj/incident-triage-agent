import { main } from "../src/cli";

process.env.AI_OPERATOR_MODE = "local";
process.env.GRAFANA_WEBHOOK_SECRET ||= "local-secret";
process.env.OPERATOR_READ_TOKEN = "";

console.error("Starting local operator demo.");
console.error("Open http://127.0.0.1:8080/runs and click Run Scenario.");

const code = await main(["serve", "--mock-llm"]);
process.exitCode = code;
