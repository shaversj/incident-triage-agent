interface ParsedArgs {
  command: string;
  positionals: string[];
  values: Map<string, string>;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    const baseUrl = process.env.AI_OPERATOR_URL ?? "http://127.0.0.1:8080";
    if (args.command === "status") {
      const incidentId = requiredPosition(args, 0, "incident id");
      print(await request(`${baseUrl}/api/incidents/${encodeURIComponent(incidentId)}/lifecycle`, "GET", readToken()));
      return 0;
    }
    if (args.command === "verify") {
      const incidentId = requiredPosition(args, 0, "incident id");
      const outcome = requiredPosition(args, 1, "outcome");
      print(await request(
        `${baseUrl}/api/incidents/${encodeURIComponent(incidentId)}/verification`,
        "POST",
        writeToken(),
        {
          outcome,
          run_id: requiredValue(args, "--run-id"),
          evidence_ids: [requiredValue(args, "--evidence-id")],
          rationale: requiredValue(args, "--rationale"),
        },
        idempotencyKey(args),
      ));
      return 0;
    }
    if (args.command === "reset") {
      const incidentId = requiredPosition(args, 0, "incident id");
      const failureClass = requiredPosition(args, 1, "failure class");
      print(await request(
        `${baseUrl}/api/incidents/${encodeURIComponent(incidentId)}/recovery/${encodeURIComponent(failureClass)}/reset`,
        "POST",
        writeToken(),
        {
          reason: requiredValue(args, "--reason"),
          rationale: requiredValue(args, "--rationale"),
          ...(args.values.get("--run-id") ? { run_id: args.values.get("--run-id") } : {}),
        },
        idempotencyKey(args),
      ));
      return 0;
    }
    if (args.command === "feedback") {
      const incidentId = requiredPosition(args, 0, "incident id");
      const category = requiredPosition(args, 1, "feedback category");
      print(await request(
        `${baseUrl}/api/incidents/${encodeURIComponent(incidentId)}/feedback`,
        "POST",
        writeToken(),
        {
          category,
          run_id: requiredValue(args, "--run-id"),
          evidence_ids: [requiredValue(args, "--evidence-id")],
          rationale: requiredValue(args, "--rationale"),
          snapshot: {},
        },
        idempotencyKey(args),
      ));
      return 0;
    }
    if (args.command === "candidates") {
      const status = args.values.get("--status") ?? "pending";
      print(await request(`${baseUrl}/api/outcome-candidates?status=${encodeURIComponent(status)}`, "GET", readToken()));
      return 0;
    }
    throw new Error(`Unknown command: ${args.command || "(missing)"}.`);
  } catch (error) {
    process.stderr.write(`Lifecycle error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positionals: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (item.startsWith("--")) {
      const value = rest[++index];
      if (!value) throw new Error(`${item} requires a value.`);
      values.set(item, value);
    } else {
      positionals.push(item);
    }
  }
  return { command, positionals, values };
}

async function request(
  url: string,
  method: "GET" | "POST",
  token: string | undefined,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error ?? `HTTP ${response.status}`));
  return payload;
}

function requiredPosition(args: ParsedArgs, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function requiredValue(args: ParsedArgs, name: string): string {
  const value = args.values.get(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function idempotencyKey(args: ParsedArgs): string {
  return args.values.get("--idempotency-key") ?? `cli:${Date.now()}`;
}

function readToken(): string | undefined {
  return process.env.OPERATOR_READ_TOKEN;
}

function writeToken(): string | undefined {
  return process.env.OPERATOR_WRITE_TOKEN;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
