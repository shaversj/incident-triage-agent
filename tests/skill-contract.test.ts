import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const skill = readFileSync(".agents/skills/incident-triage/SKILL.md", "utf8");

describe("incident-triage skill contract", () => {
  test("declares a bounded mission without production authority", () => {
    expect(skill).toContain("name: incident-triage");
    expect(skill).toContain("using only the supplied evidence package");
    expect(skill).toContain("You do not execute production changes");
    expect(skill).toContain("Do not call tools");
    expect(skill).toContain("Do not create tickets");
  });

  test("guides the model through a human-style investigation sequence", () => {
    for (const expectedPattern of [
      /current signal/i,
      /impact/i,
      /recent changes/i,
      /dependency-vs-local evidence/i,
      /evidence quality/i,
      /missing context/i,
      /next action/i,
      /verification/i,
    ]) {
      expect(skill).toMatch(expectedPattern);
    }
  });

  test("preserves the structured output fields", () => {
    for (const field of [
      "incident_class",
      "next_action",
      "confidence",
      "evidence_ids",
      "caveats",
      "verification_plan",
    ]) {
      expect(skill).toContain(field);
    }
  });

  test("requires evidence citations to come from the supplied package", () => {
    expect(skill).toContain("Cite only evidence IDs present in the supplied evidence package");
    expect(skill).toContain("verify every evidence ID appears exactly in the supplied evidence package");
  });
});
