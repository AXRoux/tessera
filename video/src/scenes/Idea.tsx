import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Shell } from "../Shell";
import { cue } from "../lib";
import { C, F } from "../theme";
import { Mark, Mono, Reveal, Sfx } from "../ui";

const id = "idea" as const;
const T_ARCH = cue(id, "the model reads");
const T_CODE = cue(id, "plain tested code");
const NOT = [
  { label: "a clever prompt", at: cue(id, "not a clever prompt") },
  { label: "a retry", at: cue(id, "not a retry") },
  { label: "a crash", at: cue(id, "not a crash") },
];

const Box: React.FC<{ at: number; left: string; width: string; label: string; color: string }> = ({ at, left, width, label, color }) => (
  <Reveal at={at} y={0} scale={1.04} style={{ position: "absolute", left, top: "13.8%", width, height: "81.8%" }}>
    <div style={{ position: "absolute", inset: 0, border: `5px solid ${color}`, boxShadow: `0 0 40px ${color}` }} />
    <div
      style={{
        position: "absolute",
        left: -5,
        top: "100%",
        marginTop: 8,
        background: color,
        color: "#fff",
        padding: "6px 18px",
        fontFamily: F.mono,
        fontWeight: 700,
        fontSize: 22,
        letterSpacing: 3,
        textTransform: "uppercase",
      }}
    >
      {label}
    </div>
  </Reveal>
);

export const Idea: React.FC = () => {
  const frame = useCurrentFrame();
  const titleOut = interpolate(frame, [T_ARCH - 14, T_ARCH], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Shell id={id} eyebrow="02 · The idea">
      <div style={{ position: "relative", width: 1740, height: 780 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: titleOut,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 30,
          }}
        >
          <Reveal at={6} scale={0.8} y={0}>
            <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
              <Mark size={230} />
              <div style={{ fontFamily: F.display, fontSize: 210, lineHeight: 1 }}>
                Tessera<span style={{ color: C.blue }}>.</span>
              </div>
            </div>
          </Reveal>
          <Reveal at={28} style={{ textAlign: "center", fontSize: 44, lineHeight: 1.3, fontWeight: 600, maxWidth: 1300 }}>
            Agents can read your balances. Tessera lets them move money{" "}
            <span style={{ color: C.soft }}>without ever paying a supplier twice.</span>
          </Reveal>
          <Reveal at={46}>
            <Mono size={20} color={C.soft}>
              Airwallex Agentic Banking Hackathon · Payment Ops Incident Commander
            </Mono>
          </Reveal>
        </div>

        <Reveal at={T_ARCH} y={30} style={{ position: "absolute", left: 250, top: 20, width: 1240, height: 678 }}>
          <div style={{ position: "relative", width: 1240, height: 678, background: "#fff", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>
            <Img src={staticFile("img/architecture.png")} style={{ width: 1240, display: "block" }} />
            <Box at={T_ARCH + 6} left="2.4%" width="39.4%" label="The model reads" color={C.blue} />
            <Box at={T_CODE} left="47.1%" width="34.1%" label="The code decides" color={C.ink} />
          </div>
        </Reveal>

        <div style={{ position: "absolute", left: 250, top: 735, width: 1240, display: "flex", justifyContent: "center", gap: 26 }}>
          {NOT.map((n) => (
            <Reveal key={n.label} at={n.at} y={14} scale={0.9}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "6px 24px",
                  border: `2px solid ${C.red}`,
                  color: C.red,
                  fontFamily: F.mono,
                  fontSize: 24,
                  fontWeight: 700,
                }}
              >
                ✕ <span style={{ color: "#fff", textDecoration: "line-through", textDecorationColor: C.red }}>{n.label}</span>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
      <Sfx id="impact" at={8} volume={0.5} />
      <Sfx id="tick" at={T_CODE} volume={0.5} />
      {NOT.map((n) => (
        <Sfx key={n.label} id="refuse" at={n.at} volume={0.35} />
      ))}
    </Shell>
  );
};
