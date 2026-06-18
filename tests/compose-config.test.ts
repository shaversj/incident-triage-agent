import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";

const dockerAvailable = spawnSync("docker", ["--version"], { encoding: "utf8" }).status === 0;

describe("Docker Compose runtime config", () => {
  test.skipIf(!dockerAvailable)("base compose keeps mock LLM agent path on the TypeScript runtime", () => {
    const config = composeConfig("docker-compose.yml");

    const agent = config.services.agent;
    expect(agent.command).toEqual(["serve", "--host", "0.0.0.0", "--port", "8080", "--mock-llm"]);
    expect(agent.depends_on).toHaveProperty("synthetic-checkout");
    expect(config.services["synthetic-checkout"].entrypoint).toEqual(["npm", "run", "synthetic-service"]);
  });

  test.skipIf(!dockerAvailable)("live compose override removes mock LLM and uses runtime provider env", () => {
    const config = composeConfig("docker-compose.yml", "docker-compose.live.yml", {
      MINIMAX_API_KEY: "test-key",
      MODEL_NAME: "test-model",
    });

    const agent = config.services.agent;
    expect(agent.command).toEqual(["serve", "--log-level", "info", "--host", "0.0.0.0", "--port", "8080"]);
    expect(agent.environment.MINIMAX_API_KEY).toBe("test-key");
    expect(agent.environment.MODEL_NAME).toBe("test-model");
    expect(agent.environment.MINIMAX_BASE_URL).toBe("https://api.minimax.io");
  });
});

function composeConfig(...args: Array<string | Record<string, string>>) {
  const envOverride = typeof args.at(-1) === "object" ? args.pop() as Record<string, string> : {};
  const files = args as string[];
  const command = ["compose"];
  for (const file of files) {
    command.push("-f", file);
  }
  command.push("config", "--format", "json");

  const result = spawnSync("docker", command, {
    cwd: process.cwd(),
    env: { ...process.env, ...envOverride },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}
