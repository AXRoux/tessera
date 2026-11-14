import React from "react";
import { Shell } from "../Shell";
import { cue, sceneFrames } from "../lib";
import { C, F } from "../theme";
import { Mono, PannedShot, Reveal, Sfx, Typed, useEnter } from "../ui";

const id = "proof" as const;
const T = {
  attacks: cue(id, "fifty adversarial"),
  tests: cue(id, "five hundred twenty-seven"),
  guards: cue(id, "ninety-four guards"),
  kill: cue(id, "we kill the process"),
  one: cue(id, "exactly one transfer"),
};
const END = sceneFrames(id);

const STATS = [
  { big: "50/50", small: "attacks held", at: T.attacks, color: C.green },
  { big: "527", small: "tests passing", at: T.tests, color: "#fff" },
  { big: "94", small: "guards removed, every one caught", at: T.guards, color: C.soft },
];

const Stat: React.FC<{ s: (typeof STATS)[number] }> = ({ s }) => (
  <Reveal at={s.at} y={30} style={{ flex: 1 }}>
    <div style={{ height: 250, border: `2px solid ${s.color}`, padding: "26px 30px", background: "rgba(255,255,255,0.04)" }}>
      <div style={{ fontFamily: F.display, fontSize: 96, color: s.color, lineHeight: 1 }}>{s.big}</div>
      <div style={{ fontSize: 28, color: C.muted, marginTop: 22, lineHeight: 1.25 }}>{s.small}</div>
    </div>
  </Reveal>
);

const LINES = [
  { at: T.kill, color: "#e8ecff", text: "$ bun run chaos" },
  { at: T.kill + 22, color: C.soft, text: "== SIGKILL after Airwallex created the transfer, before the ledger recorded it" },
  { at: T.one - 4, color: C.green, text: "   RESULT: PASS exactly one transfer, same request_id, chain intact" },
];

export const Proof: React.FC = () => {
  const stamp = useEnter(T.one + 10);
  return (
    <Shell id={id} eyebrow="07 · Proof">
      <div style={{ display: "flex", gap: 48 }}>
        <Reveal at={6} y={30}>
          <div style={{ position: "relative", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>
            <PannedShot src="img/terminal-redteam.png" imgW={1656} imgH={5354} w={520} h={780} start={10} end={T.tests + 20} style={{ borderRadius: 14 }} />
          </div>
        </Reveal>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 24 }}>
            {STATS.map((s) => (
              <Stat key={s.big} s={s} />
            ))}
          </div>
          <Reveal at={T.kill - 6} y={30} style={{ marginTop: 34 }}>
            <div style={{ background: "#05060a", border: `2px solid ${C.line}`, height: 440, borderRadius: 14, overflow: "hidden", position: "relative" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 22px", borderBottom: `1px solid ${C.line}` }}>
                {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
                  <div key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
                ))}
                <Mono size={16} style={{ marginLeft: 12 }}>
                  real Airwallex sandbox
                </Mono>
              </div>
              <div style={{ padding: "24px 28px", fontFamily: F.mono, fontSize: 23, lineHeight: 1.5 }}>
                {LINES.map((l, i) => (
                  <div key={i} style={{ color: l.color, marginBottom: 14, fontWeight: i === LINES.length - 1 ? 700 : 400 }}>
                    <Typed text={l.text} at={l.at} cps={85} cursor={false} />
                  </div>
                ))}
              </div>
              <div
                style={{
                  position: "absolute",
                  right: 34,
                  bottom: 28,
                  opacity: stamp,
                  transform: `scale(${1.3 - 0.3 * stamp}) rotate(-4deg)`,
                  border: `5px solid ${C.green}`,
                  color: C.green,
                  padding: "8px 24px",
                  fontFamily: F.display,
                  fontSize: 44,
                }}
              >
                1 transfer
              </div>
            </div>
          </Reveal>
        </div>
      </div>
      {STATS.map((s) => (
        <Sfx key={s.big} id="tick" at={s.at} volume={0.55} />
      ))}
      <Sfx id="chime" at={T.attacks + 8} volume={0.4} />
      <Sfx id="keys" at={T.kill + 22} volume={0.35} />
      <Sfx id="impact" at={T.kill + 70} volume={0.5} />
      <Sfx id="chime" at={T.one + 10} volume={0.5} />
    </Shell>
  );
};
