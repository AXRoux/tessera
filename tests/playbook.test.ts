import { describe, expect, it } from "bun:test";
import fixture from "../fixtures/failure-codes.json";
import { lookupFailure, PLAYBOOK } from "../src/domain/playbook";

describe("failure playbook", () => {
  it("has a deliberate entry, with the matching failure type, for every failure the sandbox can emit", () => {
    for (const { code, failureType } of fixture) {
      const entry = lookupFailure(code);
      expect(entry.code, `${code} ${failureType} fell through to the fallback`).toBe(code);
      expect(entry.failureType).toBe(failureType);
    }
  });

  it("has no entry for a code the sandbox cannot produce", () => {
    expect(Object.keys(PLAYBOOK).sort()).toEqual(fixture.map((row) => row.code).sort());
  });

  it("forbids automatic replacement for duplicates, compliance holds and recalls", () => {
    for (const code of ["91301", "90501", "90502", "91001", "91002"]) {
      const entry = lookupFailure(code);
      expect(entry.replace, code).toBe("FORBIDDEN");
      expect(entry.escalate, code).toBe(true);
    }
  });

  it("does not resolve prototype keys or missing codes", () => {
    for (const code of ["constructor", "__proto__", "toString", "", null, undefined]) {
      expect(lookupFailure(code).replace).toBe("FORBIDDEN");
    }
  });
});
