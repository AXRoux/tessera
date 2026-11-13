import { describe, expect, it } from "bun:test";
import { initialsOf } from "../web/lib/initials";
import { safeNext } from "../web/lib/safe-next";

describe("who is signed in, shown", () => {
  it("takes initials from a full name, then from an email address", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("  Vance  de la Poitier ")).toBe("VP");
    expect(initialsOf("ada.lovelace@example.com")).toBe("AL");
    expect(initialsOf("ada@example.com")).toBe("AD");
  });
});

describe("where signing in goes next", () => {
  it("follows a path on this site and nothing else", () => {
    expect(safeNext("/queue", "/dashboard")).toBe("/queue");
    expect(safeNext("//evil.example/x", "/dashboard")).toBe("/dashboard");
    expect(safeNext("https://evil.example", "/dashboard")).toBe("/dashboard");
    expect(safeNext(null, "/dashboard")).toBe("/dashboard");
  });
});
