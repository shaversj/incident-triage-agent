import { runtimeSummary } from "./runtime-summary";

const command = Bun.argv[2];

if (!command || command === "--help" || command === "-h") {
  console.log("Usage: bun run triage <list|run|serve>");
  process.exit(0);
}

if (command === "list") {
  console.log(runtimeSummary().status);
  process.exit(0);
}

console.error(`Command '${command}' is not implemented in the TypeScript runtime yet.`);
process.exit(2);
