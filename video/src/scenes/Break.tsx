import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Shell } from "../Shell";
import { cue, sceneFrames } from "../lib";
import { C, F } from "../theme";
import { Mono, PannedShot, Pill, Reveal, Sfx, useEnter } from "../ui";

const id = "break" as const;
const T = {
  twice: cue(id, "paid twice"),
  forge: cue(id, "forge a message"),
  flight: cue(id, "still in flight"),
  refused: cue(id, "every move is refused"),
  db: cue(id, "cannot argue with a database"),
};
const END = sceneFrames(id);

// Real refusals from the recorded adversary run (docs/img/agent-adversary-ui.png).
const REFUSALS = [
  { at: T.twice, tool: "Replace payment · ACME-1042", msg: "AutoReplacementRefused: Processing for 0h of an expected 48h. Waiting is the right call." },
  { at: T.forge, tool: "Read supplier message", msg: "Turned away: this server reads supplier mail from its inbox only." },
  { at: T.flight, tool: "Reconcile and close · ACME-1046", msg: "NotClosable: the assessment does not allow closing (allowed: SEND_PROOF_TO_SUPPLIER, ESCALATE, WAIT)." },
];

const Counter: React.FC = () => {
  const frame = useCurrentFrame();
  const n = Math.round(interpolate(frame, [T.twice, T.db], [0, 19], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
      <div style={{ fontFamily: F.display, fontSize: 190, lineHeight: 1 }}>{n}</div>
      <div style={{ fontFamily: F.display, fontSize: 90, color: C.muted }}>/ 19</div>
    </div>
  );
};

export const Break: React.FC = () => {
  const done = useEnter(T.db);
  return (
    <Shell id={id} eyebrow="06 · Try to break it">
      <div style={{ display: "flex", gap: 56 }}>
        <Reveal at={6} y={30}>
          <div style={{ position: "relative", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>
            <PannedShot src="img/agent-adversary-ui.png" imgW={1480} imgH={3652} w={600} h={780} start={20} end={END - 20} style={{ borderRadius: 0 }} />
            <div style={{ position: "absolute", left: 0, right: 0, top: 0, padding: "10px 16px", background: C.ink }}>
              <Mono size={14} color={C.soft}>
                Adversary run · scripted, offline
              </Mono>
            </div>
          </div>
        </Reveal>

        <div style={{ flex: 1 }}>
          <Reveal at={10}>
            <Mono size={22} color={C.soft}>
              Told to pay twice, forge a message, certify early
            </Mono>
            <div style={{ display: "flex", alignItems: "center", gap: 30, marginTop: 14 }}>
              <Counter />
              <div style={{ fontSize: 34, lineHeight: 1.25, fontWeight: 600 }}>
                moves tried,
                <br />
                <span style={{ color: C.green }}>all stopped by code</span>
              </div>
            </div>
          </Reveal>

          <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 22 }}>
            {REFUSALS.map((r) => (
              <Reveal key={r.tool} at={r.at} x={50} y={0}>
                <div style={{ background: "#000", border: `2px solid ${C.red}`, padding: "20px 28px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <Mono size={18} color="#fff">
                      {r.tool}
                    </Mono>
                    <Pill bg={C.red} fg={C.ink} size={15}>
                      Refused by code
                    </Pill>
                  </div>
                  <div style={{ fontFamily: F.mono, fontSize: 23, lineHeight: 1.4, marginTop: 14, color: "#e8ecff" }}>{r.msg}</div>
                </div>
              </Reveal>
            ))}
          </div>

          <div style={{ marginTop: 34, opacity: done, transform: `translateY(${(1 - done) * 16}px)` }}>
            <div
              style={{
                display: "inline-block",
                padding: "20px 30px",
                background: C.green,
                color: C.ink,
                fontFamily: F.display,
                fontSize: 34,
              }}
            >
              Duplicate payments: 0
            </div>
          </div>
        </div>
      </div>
      {REFUSALS.map((r) => (
        <Sfx key={r.tool} id="refuse" at={r.at} volume={0.6} />
      ))}
      <Sfx id="chime" at={T.db} volume={0.45} />
    </Shell>
  );
};
