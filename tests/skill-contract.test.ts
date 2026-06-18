import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("incident-triage skill declares bounded mission and output fields", () => {
  const skill = readFileSync("src/flue/skills/incident-triage/SKILL.md", "utf8");

  expect(skill).toContain("name: incident-triage");
  expect(skill).toContain("You do not execute production changes");
  expect(skill).toContain("evidence_ids");
  expect(skill).toContain("verification_plan");
});
