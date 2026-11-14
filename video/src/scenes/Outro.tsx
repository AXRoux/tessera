import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Shell } from "../Shell";
import { cue } from "../lib";
import { C, F } from "../theme";
import { Mark, Mono, Reveal, Sfx, Typed } from "../ui";

const id = "outro" as const;
const T = {
  mcp: cue(id, "it speaks mcp"),
  logos: cue(id, "claude code"),
  tools: cue(id, "the same ten tools"),
  limits: cue(id, "it is sandbox only"),
  end: cue(id, "money that moves once"),
};

const AGENTS = [
  { file: "claude.svg", name: "Claude Code", at: cue(id, "claude code") },
  { file: "openai.svg", name: "Codex", at: cue(id, "codex") },
  { file: "cursor.svg", name: "Cursor", at: cue(id, "cursor") },
  { file: "gemini.svg", name: "Gemini CLI", at: cue(id, "gemini") },
  { file: "githubcopilot.svg", name: "Copilot", at: cue(id, "copilot") },
  { file: "hermes-agent.svg", name: "Hermes Agent", at: cue(id, "hermes agent") },
];

const LIMITS = [
  { label: "Sandbox only", at: cue(id, "sandbox only") },
  { label: "One operator", at: cue(id, "one operator") },
  { label: "Tamper-evident, not tamper-proof", at: cue(id, "tamper-evident") },
];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const body = interpolate(frame, [T.end - 16, T.end - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const endIn = interpolate(frame, [T.end - 2, T.end + 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Shell id={id} eyebrow="08 · Plug it in">
      <div style={{ position: "relative", width: 1740, height: 780 }}>
        <div style={{ position: "absolute", inset: 0, opacity: body }}>
          <Reveal at={T.mcp - 6}>
            <div style={{ fontFamily: F.display, fontSize: 72 }}>
              Any MCP agent<span style={{ color: C.blue }}>.</span> Same ten tools<span style={{ color: C.blue }}>.</span>
            </div>
          </Reveal>

          <div style={{ display: "flex", gap: 26, marginTop: 56 }}>
            {AGENTS.map((a) => (
              <Reveal key={a.name} at={a.at} y={24} scale={0.9} style={{ width: 261 }}>
                <div
                  style={{
                    background: "#fff",
                    height: 190,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
                  }}
                >
                  <Img src={staticFile(`img/agents/${a.file}`)} style={{ height: 84, maxWidth: 160 }} />
                </div>
                <div style={{ fontSize: 26, fontWeight: 600, textAlign: "center", marginTop: 16 }}>{a.name}</div>
              </Reveal>
            ))}
          </div>

          <Reveal at={T.tools} y={20} style={{ marginTop: 50 }}>
            <div style={{ background: "#05060a", border: `2px solid ${C.line}`, padding: "24px 32px", fontFamily: F.mono, fontSize: 27, color: "#e8ecff" }}>
              <span style={{ color: C.soft }}>$ </span>
              <Typed text="hermes mcp add tessera --command bun --args run --silent --cwd /path/to/tessera mcp" at={T.tools + 4} cps={60} />
            </div>
          </Reveal>

          <div style={{ display: "flex", gap: 22, marginTop: 44 }}>
            {LIMITS.map((l) => (
              <Reveal key={l.label} at={l.at} y={16}>
                <div style={{ border: `2px solid ${C.amber}`, color: C.amber, padding: "10px 24px", fontFamily: F.mono, fontSize: 25, fontWeight: 700 }}>
                  {l.label}
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: endIn,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 34,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 40, transform: `scale(${0.94 + 0.06 * endIn})` }}>
            <Mark size={200} />
            <div style={{ fontFamily: F.display, fontSize: 190, lineHeight: 1 }}>
              Tessera<span style={{ color: C.blue }}>.</span>
            </div>
          </div>
          <div style={{ fontSize: 50, fontWeight: 600 }}>
            Money that moves once, <span style={{ color: C.soft }}>and can prove it.</span>
          </div>
          <Mono size={24} color={C.soft}>
            github.com/AXRoux/tessera · Airwallex Agentic Banking Hackathon
          </Mono>
        </div>
      </div>
      {AGENTS.map((a) => (
        <Sfx key={a.name} id="tick" at={a.at} volume={0.4} />
      ))}
      <Sfx id="keys" at={T.tools + 4} volume={0.3} />
      {LIMITS.map((l) => (
        <Sfx key={l.label} id="tick" at={l.at} volume={0.4} />
      ))}
      <Sfx id="impact" at={T.end} volume={0.55} />
    </Shell>
  );
};
