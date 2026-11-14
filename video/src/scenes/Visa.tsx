import React from "react";
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Shell } from "../Shell";
import { cue, sceneFrames } from "../lib";
import { C, F } from "../theme";
import { Camera, Mono, Pill, Reveal, Sfx, useEnter } from "../ui";

const id = "visa" as const;
const T = {
  buy: cue(id, "need to buy things"),
  card: cue(id, "single-use visa card"),
  code: cue(id, "code checks the request"),
  signs: cue(id, "a named person signs it"),
  controls: cue(id, "own controls"),
  tap: cue(id, "trusted agent protocol"),
  verifies: cue(id, "merchant verifies"),
  declines: cue(id, "the network declines"),
  proves: cue(id, "tessera proves it"),
  different: cue(id, "charged by a different merchant"),
  flagged: cue(id, "it is flagged"),
};
const END = sceneFrames(id);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/* ── Part one: the cards, and the path a card takes before it exists ─────────────────────────────────────────── */

// The sign-up card plates (fal.ai, upscaled), one per agent. The front one is the card this purchase gets.
const PLATES = ["claude", "gemini", "cursor", "copilot", "openai", "hermes"] as const;

const ArtCard: React.FC<{ plate: string; last4: string; merchant: string; w?: number }> = ({ plate, last4, merchant, w = 560 }) => {
  const h = w / 1.586;
  const s = w / 560;
  return (
    <div style={{ width: w, height: h, borderRadius: 28 * s, overflow: "hidden", position: "relative", boxShadow: "0 40px 80px rgba(0,0,0,0.55)", border: "1.5px solid rgba(255,255,255,0.22)" }}>
      <Img src={staticFile(`cards/${plate}.webp`)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, rgba(3,4,7,0.62) 0%, rgba(3,4,7,0.2) 55%, transparent 80%), linear-gradient(0deg, rgba(3,4,7,0.55), transparent 45%)" }} />
      <div style={{ position: "absolute", left: 30 * s, top: 26 * s, fontFamily: F.display, fontSize: 22 * s, letterSpacing: 3 * s, color: "#fff" }}>TESSERA</div>
      <div style={{ position: "absolute", right: 30 * s, top: 20 * s, fontFamily: "Arial Black, Helvetica, sans-serif", fontStyle: "italic", fontWeight: 900, fontSize: 40 * s, letterSpacing: -2 * s, color: "#fff" }}>VISA</div>
      <div style={{ position: "absolute", left: 30 * s, bottom: 56 * s, fontFamily: F.mono, fontSize: 24 * s, letterSpacing: 4 * s, color: "#fff" }}>•••• •••• •••• {last4}</div>
      <div style={{ position: "absolute", left: 30 * s, bottom: 26 * s, fontFamily: F.body, fontSize: 17 * s, color: "rgba(255,255,255,0.85)" }}>{merchant}</div>
      <svg viewBox="0 0 44 34" style={{ position: "absolute", right: 30 * s, bottom: 28 * s, width: 46 * s, height: 36 * s }} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.2">
        <rect x="1" y="1" width="42" height="32" rx="7" />
        <path d="M1 12h12v10H1M43 12H31v10h12M13 1v11M31 1v11M13 22v11M31 22v11M13 17h18" />
      </svg>
    </div>
  );
};

const Fan: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const gather = spring({ frame: Math.max(0, frame - T.card), fps, config: { damping: 18, mass: 0.9 }, durationInFrames: 40 });
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 860, height: 780 }}>
      {PLATES.map((plate, i) => {
        const front = i === PLATES.length - 1;
        const enter = spring({ frame: Math.max(0, frame - T.buy - i * 4), fps, config: { damping: 16 }, durationInFrames: 34 });
        const spread = i - (PLATES.length - 1) / 2;
        const angle = spread * 8 * (1 - gather);
        const x = 160 + spread * 48 * (1 - gather);
        const y = 210 + Math.abs(spread) * 14 * (1 - gather) + (1 - enter) * 420 - (front ? 0 : 10 * gather * (PLATES.length - 1 - i));
        const fade = front ? 1 : 1 - 0.75 * gather;
        return (
          <div key={plate} style={{ position: "absolute", left: x, top: y, opacity: enter * fade, transform: `rotate(${angle}deg) scale(${front ? 1 + 0.06 * gather : 1 - 0.04 * gather})`, transformOrigin: "50% 120%" }}>
            <ArtCard plate={plate} last4={["4021", "8812", "3307", "6650", "1198", "7838"][i]!} merchant={["Anthropic", "Google Cloud", "Cursor", "GitHub", "OpenAI", "Framer"][i]!} />
          </div>
        );
      })}
      <Reveal at={T.card + 18} y={16} style={{ position: "absolute", left: 210, top: 640, display: "flex", gap: 12 }}>
        <Pill bg={C.blue} size={18}>
          Single use
        </Pill>
        <Pill bg="#fff" fg={C.ink} size={18}>
          Issued by Airwallex
        </Pill>
      </Reveal>
    </div>
  );
};

const PATH = [
  { at: T.buy + 20, who: "Agent", text: "Asks for a card for one purchase" },
  { at: T.code, who: "Code", text: "Checks it: category, limits, today's total, the reserve floor" },
  { at: T.signs, who: "A person", text: "Signs it, with a written note" },
  { at: T.controls - 10, who: "Airwallex", text: "Issues a Visa with the signed terms as its controls" },
];

const CONTROLS = ["Cap $450, per charge and for life", "Software merchants only", "One charge", "Ends in 7 days"];

const Path: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: "absolute", left: 930, top: 20, width: 810 }}>
      {PATH.map((s, i) => {
        const next = PATH[i + 1]?.at ?? T.tap;
        const active = frame >= s.at && frame < next;
        const p = useEnter(s.at);
        return (
          <div key={s.who} style={{ display: "flex", gap: 22, alignItems: "baseline", padding: "20px 26px", marginBottom: 10, borderLeft: `6px solid ${active ? C.blue : C.line}`, background: active ? "rgba(31,77,255,0.16)" : "transparent", opacity: frame >= s.at ? (active ? 1 : 0.6) * p : 0.15 }}>
            <Mono size={19} color={C.soft} style={{ width: 150, flex: "none" }}>
              {s.who}
            </Mono>
            <div style={{ fontSize: 31, fontWeight: 600, lineHeight: 1.25 }}>{s.text}</div>
          </div>
        );
      })}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 26, paddingLeft: 26 }}>
        {CONTROLS.map((c, i) => (
          <Reveal key={c} at={T.controls + i * 5} y={14}>
            <Pill bg="transparent" fg="#fff" border={C.soft} size={18}>
              {c}
            </Pill>
          </Reveal>
        ))}
      </div>
    </div>
  );
};

/* ── Part two: the real card screens ────────────────────────────────────────────────────────────────────────── */

const STEPS = [
  { at: T.tap, title: "Visa Trusted Agent Protocol", sub: "The agent signs the checkout: Ed25519, agent-payer-auth", tone: C.soft },
  { at: T.verifies, title: "The merchant verifies, then charges", sub: "Signature and a nonce-linked payment container", tone: C.soft },
  { at: T.declines, title: "Not signed for? Declined.", sub: "LIMIT_EXCEEDED · MERCHANT_CATEGORY_NOT_ALLOWED", tone: C.red },
  { at: T.proves, title: "Proved against what was signed", sub: "Merchant · cap · category · currency · single use · signature", tone: C.green },
  { at: T.different, title: "Wrong merchant? Flagged.", sub: "Charged by Canva on a card signed for Figma", tone: C.red },
];

const Steps: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 520 }}>
      {STEPS.map((s, i) => {
        const next = STEPS[i + 1]?.at ?? Infinity;
        const active = frame >= s.at && frame < next;
        const p = useEnter(s.at);
        return (
          <div key={s.title} style={{ padding: "18px 22px", marginBottom: 8, borderLeft: `6px solid ${active ? s.tone : C.line}`, background: active ? "rgba(255,255,255,0.06)" : "transparent", opacity: frame >= s.at ? (active ? 1 : 0.5) * p : 0, transform: `translateY(${(1 - p) * 20}px)` }}>
            <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.2, color: active ? "#fff" : "rgba(255,255,255,0.85)" }}>{s.title}</div>
            <div style={{ fontFamily: F.mono, fontSize: 17, color: C.muted, marginTop: 8, lineHeight: 1.4 }}>{s.sub}</div>
          </div>
        );
      })}
    </div>
  );
};

const SHOT = { imgW: 3200, imgH: 2000, w: 1180, h: 780 };

const Screens: React.FC = () => {
  const frame = useCurrentFrame();
  const vercel = interpolate(frame, [T.verifies - 6, T.verifies + 8], [1, 0], clamp);
  const figma = interpolate(frame, [T.different - 4, T.different + 10], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 560, top: 0, width: SHOT.w, height: SHOT.h, borderRadius: 18, border: `1px solid ${C.line}`, boxShadow: "0 40px 100px rgba(0,0,0,0.65)", overflow: "hidden" }}>
      <Camera
        src="img/v2/card-framer.jpg"
        {...SHOT}
        keys={[
          { at: 0, x: 866, y: 1300, width: 1200 },
          { at: T.declines, x: 880, y: 1540, width: 1000 },
          { at: T.proves, x: 1560, y: 680, width: 800, dur: 36 },
        ]}
        style={{ position: "absolute", inset: 0 }}
      />
      <div style={{ position: "absolute", inset: 0, opacity: vercel }}>
        <Camera
          src="img/v2/card-vercel.jpg"
          {...SHOT}
          keys={[
            { at: 0, x: 860, y: 380, width: 1500 },
            { at: T.tap + 20, x: 1560, y: 700, width: 800, dur: 40 },
          ]}
        />
      </div>
      <div style={{ position: "absolute", inset: 0, opacity: figma }}>
        <Camera
          src="img/v2/card-figma.jpg"
          {...SHOT}
          keys={[
            { at: 0, x: 840, y: 300, width: 1520 },
            { at: T.flagged - 8, x: 1560, y: 750, width: 800, dur: 34 },
          ]}
        />
      </div>
    </div>
  );
};

export const Visa: React.FC = () => {
  const frame = useCurrentFrame();
  const partOne = interpolate(frame, [T.tap - 14, T.tap], [1, 0], clamp);
  const partTwo = interpolate(frame, [T.tap - 6, T.tap + 10], [0, 1], clamp);
  return (
    <Shell id={id} eyebrow="08 · Agents that buy, on Visa">
      {partOne > 0 ? (
        <div style={{ position: "absolute", inset: 0, opacity: partOne }}>
          <Fan />
          <Path />
        </div>
      ) : null}
      {partTwo > 0 ? (
        <div style={{ position: "absolute", inset: 0, opacity: partTwo, transform: `translateY(${(1 - partTwo) * 30}px)` }}>
          <Steps />
          <Screens />
        </div>
      ) : null}
      <Sfx id="whoosh" at={T.buy} volume={0.35} />
      <Sfx id="tick" at={T.code} volume={0.45} />
      <Sfx id="tick" at={T.signs} volume={0.45} />
      <Sfx id="chime" at={T.controls} volume={0.3} />
      <Sfx id="tap" at={T.verifies + 10} volume={0.5} />
      <Sfx id="refuse" at={T.declines + 4} volume={0.45} />
      <Sfx id="chime" at={T.proves + 10} volume={0.45} />
      <Sfx id="alert" at={T.flagged} volume={0.4} />
      <Sfx id="impact" at={END - 40} volume={0.2} />
    </Shell>
  );
};
