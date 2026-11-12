import { describe, expect, it } from "bun:test";
import { passwordStrength } from "../web/lib/password-strength";

describe("the sign-up strength meter", () => {
  it("calls anything under the server's minimum too short", () => {
    expect(passwordStrength("Sh0rt!pw")).toEqual({ score: 0, label: "Too short" });
  });
  it("rewards length and variety, and a passphrase most of all", () => {
    expect(passwordStrength("abcdefghij").score).toBeLessThanOrEqual(1);
    expect(passwordStrength("Correct-Horse-9").score).toBeGreaterThanOrEqual(3);
    expect(passwordStrength("correct horse battery staple").label).toBe("Excellent");
  });
  it("marks down the passwords people reach for first", () => {
    expect(passwordStrength("Password12345!").score).toBeLessThanOrEqual(2);
    expect(passwordStrength("aaaaaaaaaaaaaaaa").score).toBe(1);
  });
});
