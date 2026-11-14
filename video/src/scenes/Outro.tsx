import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Shell } from "../Shell";
import { cue } from "../lib";
import { C, F } from "../theme";
import { Camera, Mark, Mono, Pill, Reveal, Sfx, Typed } from "../ui";

const id = "outro" as const;
const T = {
  mcp: cue(id, "it speaks mcp"),
  logos: cue(id, "claude code"),
  tools: cue(id, "the same thirteen tools"),
  live: cue(id, "and it is live"),
  signup: cue(id, "sign up"),
  pick: cue(id, "pick your agent"),
  keys: cue(id, "bring your own"),
  limits: cue(id, "sandbox only"),
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
  { label: "Tamper-evident, not tamper-proof", at: cue(id, "tamper-evident") },
  { label: "Limits written down", at: cue(id, "the limits are written down") },
];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const body = interpolate(frame, [T.live - 14, T.live], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const live = interpolate(frame, [T.live - 6, T.live + 12, T.end - 16, T.end - 2], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const endIn = interpolate(frame, [T.end - 2, T.end + 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Shell id={id} eyebrow="10 · Plug it in">
      <div style={{ position: "relative", width: 1740, height: 780 }}>
        <div style={{ position: "absolute", inset: 0, opacity: body }}>
          <Reveal at={T.mcp - 6}>
            <div style={{ fontFamily: F.display, fontSize: 72 }}>
              Any MCP agent<span style={{ color: C.blue }}>.</span> Same thirteen tools<span style={{ color: C.blue }}>.</span>
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

        </div>

        {live > 0 ? (
          <div style={{ position: "absolute", inset: 0, opacity: live, display: "flex", gap: 56, alignItems: "flex-start" }}>
            <div style={{ borderRadius: 18, border: `1px solid ${C.line}`, boxShadow: "0 40px 100px rgba(0,0,0,0.65)", overflow: "hidden", flex: "none" }}>
              <Camera
                src="img/v2/signup.jpg"
                imgW={2880}
                imgH={1800}
                w={1100}
                h={690}
                keys={[
                  { at: 0, x: 0, y: 0, width: 2880 },
                  { at: T.pick - 10, x: 300, y: 500, width: 1400, dur: 40 },
                ]}
              />
            </div>
            <div style={{ flex: 1, paddingTop: 10 }}>
              <Reveal at={T.live}>
                <div style={{ fontFamily: F.display, fontSize: 64, lineHeight: 1.05 }}>
                  It is live<span style={{ color: C.blue }}>.</span>
                </div>
              </Reveal>
              {[
                { at: T.signup, text: "Sign up" },
                { at: T.pick, text: "Pick your agent" },
                { at: T.keys, text: "Bring your own Airwallex sandbox keys" },
              ].map((step, i) => (
                <Reveal key={step.text} at={step.at} y={16} style={{ marginTop: i === 0 ? 40 : 18 }}>
                  <div style={{ display: "flex", gap: 18, alignItems: "baseline" }}>
                    <Mono size={22} color={C.soft}>
                      0{i + 1}
                    </Mono>
                    <div style={{ fontSize: 34, fontWeight: 600, lineHeight: 1.25 }}>{step.text}</div>
                  </div>
                </Reveal>
              ))}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 14, marginTop: 44 }}>
                {LIMITS.map((l) => (
                  <Reveal key={l.label} at={l.at} y={16}>
                    <div style={{ border: `2px solid ${C.amber}`, color: C.amber, padding: "10px 22px", fontFamily: F.mono, fontSize: 22, fontWeight: 700 }}>
                      {l.label}
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>
          </div>
        ) : null}

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
      <Sfx id="whoosh" at={T.live - 6} volume={0.3} />
      <Sfx id="tap" at={T.pick + 8} volume={0.35} />
      {LIMITS.map((l) => (
        <Sfx key={l.label} id="tick" at={l.at} volume={0.4} />
      ))}
      <Sfx id="impact" at={T.end} volume={0.55} />
    </Shell>
  );
};
