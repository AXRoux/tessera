import { describe, expect, it } from "bun:test";
import { faceForModel, parseFaceChoice, resolveFace } from "../web/lib/agent-face";

describe("the agent's face", () => {
  it("follows the model when the model says who it is", () => {
    expect(faceForModel("Claude")).toBe("claude");
    expect(faceForModel("claude-sonnet-4-5")).toBe("claude");
    expect(faceForModel("anthropic/claude-opus-4")).toBe("claude");
    expect(faceForModel("gpt-5")).toBe("openai");
    expect(faceForModel("openai/gpt-4.1-mini")).toBe("openai");
    expect(faceForModel("o3-mini")).toBe("openai");
    expect(faceForModel("gemini-2.5-pro")).toBe("gemini");
    expect(faceForModel("hermes-4-405b")).toBe("hermes");
    expect(faceForModel("NousResearch/Hermes-4-70B")).toBe("hermes");
  });

  it("does not guess for a model that does not say, nor mistake a word that merely contains a name", () => {
    expect(faceForModel("deepseek-v4-pro")).toBeNull();
    expect(faceForModel("z-ai/glm-5.2")).toBeNull();
    expect(faceForModel("pro4-model")).toBeNull();
    expect(faceForModel(null)).toBeNull();
  });

  it("lets a pinned face win, and falls back to Hermes when auto has nothing to follow", () => {
    expect(resolveFace("auto", "claude-sonnet-4-5").id).toBe("claude");
    expect(resolveFace("cursor", "claude-sonnet-4-5").id).toBe("cursor");
    expect(resolveFace("auto", "deepseek-v4-pro").id).toBe("hermes");
    expect(resolveFace("auto", null).id).toBe("hermes");
    expect(parseFaceChoice("copilot")).toBe("copilot");
    expect(parseFaceChoice("not-a-face")).toBe("auto");
    expect(parseFaceChoice(undefined)).toBe("auto");
  });
});
