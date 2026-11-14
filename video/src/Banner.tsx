import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { C, F } from "./theme";

// README banner (docs/img/banner.png, 2000x719). Rebuilt so the badge matches the repo: 50/50 attacks held.
const CELL = 58;
const BLUE_CELLS: [number, number, number][] = [
  [0, 0, 0.35], [2, 0, 0.9], [4, 0, 0.5], [1, 1, 0.5], [3, 2, 0.85], [5, 3, 0.9], [0, 4, 0.25], [2, 5, 0.45],
  [4, 6, 0.35], [1, 7, 0.4], [3, 8, 0.7], [5, 9, 0.9], [6, 5, 0.3], [6, 1, 0.45], [0, 9, 0.5], [2, 10, 0.4],
];

const Pill: React.FC<{ children: string; solid?: boolean }> = ({ children, solid }) => (
  <div
    style={{
      height: 58,
      padding: "0 26px",
      display: "flex",
      alignItems: "center",
      background: solid ? C.blue : "rgba(255,255,255,0.02)",
      border: solid ? `2px solid ${C.blue}` : "2px solid rgba(255,255,255,0.16)",
      color: solid ? "#fff" : "rgba(255,255,255,0.88)",
      fontFamily: F.mono,
      fontWeight: 700,
      fontSize: 18,
      letterSpacing: 2.8,
      textTransform: "uppercase",
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </div>
);

export const Banner: React.FC = () => (
  <AbsoluteFill style={{ background: "#0a0c11", fontFamily: F.body, color: "#fff" }}>
    <div
      style={{
        position: "absolute",
        left: 1180,
        top: 0,
        width: 820,
        height: 719,
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)",
        backgroundSize: `${CELL}px ${CELL}px`,
        WebkitMaskImage: "linear-gradient(90deg, transparent 0%, #000 45%)",
      }}
    >
      {BLUE_CELLS.map(([x, y, o], i) => (
        <div key={i} style={{ position: "absolute", left: 120 + x * CELL + (x % 2 ? 0 : CELL), top: y * CELL, width: CELL - 2, height: CELL - 2, background: C.blue, opacity: o }} />
      ))}
    </div>

    <div style={{ position: "absolute", left: 100, top: 82, display: "flex", alignItems: "center", gap: 22 }}>
      <div style={{ width: 18, height: 18, background: C.blue }} />
      <div style={{ fontFamily: F.mono, fontSize: 19, letterSpacing: 3.8, color: C.soft, textTransform: "uppercase" }}>
        Airwallex Agentic Banking Hackathon · Payment Ops Incident Commander
      </div>
    </div>

    <div style={{ position: "absolute", left: 96, top: 166, fontFamily: F.display, fontSize: 198, lineHeight: 1 }}>
      Tessera<span style={{ color: C.blue }}>.</span>
    </div>

    <div style={{ position: "absolute", left: 100, top: 420, width: 1250, fontSize: 47, fontWeight: 700, lineHeight: 1.26, letterSpacing: -0.4 }}>
      Agents can read your balances. Tessera lets them
      <br />
      move money <span style={{ color: C.soft }}>without ever paying a supplier twice.</span>
    </div>

    <div style={{ position: "absolute", left: 100, top: 566, display: "flex", gap: 14 }}>
      <Pill solid>50 / 50 attacks held</Pill>
      <Pill>MCP server</Pill>
      <Pill>Live on Airwallex sandbox</Pill>
      <Pill>Claude, quarantined</Pill>
    </div>

    <div
      style={{
        position: "absolute",
        left: 1425,
        top: 106,
        width: 500,
        height: 500,
        background: "#fff",
        clipPath: "polygon(0 0, 78% 0, 100% 22%, 100% 100%, 22% 100%, 0 78%)",
      }}
    >
      <Img src={staticFile("brand/tessera-mark.png")} style={{ position: "absolute", left: 38, top: 38, width: 424, height: 424 }} />
    </div>
  </AbsoluteFill>
);
