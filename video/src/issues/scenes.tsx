import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import {
  burstLayers, Chapter, Desk, Kicker, NativeGlobe, PLACES, Rise, Screen, Sfx, SUPPLIERS,
  type Cam, type CursorTrack, type GlobePin, type Layer, type Ring,
} from "./components";
import { beatFrames, burstFiles, C, centre, clamp, css, cue, ease, F, H, hasRect, rect, shotFile, voiceEnd, W, type Rect } from "./kit";
import type { BeatId } from "./script";

/** A rect if the capture recorded it, else a fallback region (CSS pixels of the 1920x1080 console). */
const R = (shot: string, name: string, fallback: Rect, pad = 6): Rect => (hasRect(shot, name) ? rect(shot, name, pad) : fallback);
const at = (shot: string, from = 0, fade = 12): Layer => ({ from, file: shotFile(shot), fade });
const click = (target: Rect, arrive: number, press: number, from?: { x: number; y: number }): CursorTrack => {
  const c = centre(target);
  const start = from ?? { x: c.x + 520, y: c.y + 340 };
  return { points: [{ at: arrive - 26, ...start }, { at: arrive, x: c.x, y: c.y }], clicks: [press] };
};

// Regions of the console every capture shares (CSS pixels at 1920x1080).
const AGENT_COL = css(1500, 230, 410, 830);
const RIGHT_COL = css(1240, 240, 680, 830);
const CENTER = css(395, 230, 1150, 860);

const Brand: React.FC = () => (
  <div style={{ position: "absolute", left: 200, top: 150, display: "flex", alignItems: "center", gap: 30 }}>
    <Img src={staticFile("brand/tessera-mark.png")} style={{ width: 92, height: 92 }} />
    <span style={{ fontFamily: F.ui, fontWeight: 600, fontSize: 60, letterSpacing: -1.5, color: C.fg }}>Tessera</span>
  </div>
);

const pinsFor = (tone: (id: string) => string, show: (i: number) => number, pulse: boolean): GlobePin[] =>
  ["primeintellect", "replicate", "langchain", "fal", "modal", "framer"].map((id, i) => ({ s: SUPPLIERS[id]!, ...PLACES[id]!, tone: tone(id), show: show(i), pulse }));

/* ── 1. Six payments, stuck ─────────────────────────────────────────────────────────────────────────────────── */
export const Open: React.FC = () => {
  const f = useCurrentFrame();
  const id: BeatId = "open";
  const six = cue(id, "six payments");
  const stuck = cue(id, "stuck");
  const lon = -98 + interpolate(f, [0, beatFrames(id)], [-34, 2], clamp);
  const zoomIn = ease(interpolate(f, [0, 70], [0, 1], clamp));
  return (
    <Desk>
      <AbsoluteFill style={{ opacity: zoomIn, transform: `scale(${0.9 + 0.1 * zoomIn})` }}>
        <NativeGlobe radius={860} cy={H * 0.53} lon={lon} lat={33} pins={pinsFor(() => (f >= stuck ? C.bad : C.accent), (i) => six + 8 + i * 5, f >= stuck)} />
      </AbsoluteFill>
      <Brand />
      <Rise at={stuck + 18} style={{ position: "absolute", left: 0, right: 0, bottom: 300, textAlign: "center" }}>
        <Kicker>Supplier issues · this morning</Kicker>
      </Rise>
    </Desk>
  );
};

/* ── 2. What an agent can get wrong ─────────────────────────────────────────────────────────────────────────── */
const Stake: React.FC<{ at: number; n: string; kicker: string; line: string }> = ({ at, n, kicker, line }) => (
  <Rise at={at} style={{ display: "flex", alignItems: "baseline", gap: 60 }}>
    <span style={{ fontFamily: F.mono, fontSize: 44, color: C.faint, width: 110 }}>{n}</span>
    <div>
      <div style={{ fontFamily: F.ui, fontSize: 56, color: C.muted, letterSpacing: -0.5 }}>{kicker}</div>
      <div style={{ fontFamily: F.ui, fontSize: 170, fontWeight: 600, letterSpacing: -6, color: C.bad, lineHeight: 1.05 }}>{line}</div>
    </div>
  </Rise>
);
export const Stakes: React.FC = () => {
  const id: BeatId = "stakes";
  return (
    <Desk glow="rgba(255,79,94,0.12)">
      <div style={{ position: "absolute", left: 420, top: 330, display: "flex", flexDirection: "column", gap: 90 }}>
        <Stake at={cue(id, "Pay again") } n="01" kicker="Pay again while the first transfer is still moving" line="Paid twice" />
        <Stake at={cue(id, "believe")} n="02" kicker="Believe “we've changed banks”" line="Paid a fraudster" />
        <Stake at={cue(id, "Hand an agent")} n="03" kicker="Hand an agent raw payment keys" line="Both, in seconds" />
      </div>
    </Desk>
  );
};

/* ── 3. The layer ───────────────────────────────────────────────────────────────────────────────────────────── */
const Tier: React.FC<{ at: number; n: string; head: string; sub: string; tone: string }> = ({ at, n, head, sub, tone }) => (
  <Rise at={at}>
    <div
      style={{
        display: "flex", alignItems: "center", gap: 56, width: 2500, padding: "54px 70px", borderRadius: 60,
        background: `linear-gradient(180deg, ${C.tile} 0%, ${C.tileBottom} 100%)`, border: "2px solid rgba(255,255,255,0.065)",
        boxShadow: "inset 0 2px 0 rgba(255,255,255,0.06), 0 40px 80px -40px rgba(0,0,0,0.9)",
      }}
    >
      <span style={{ width: 120, height: 120, borderRadius: 36, background: `${tone}22`, color: tone, border: `3px solid ${tone}66`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.mono, fontSize: 46 }}>{n}</span>
      <div>
        <div style={{ fontFamily: F.ui, fontSize: 90, fontWeight: 600, letterSpacing: -2.5, color: C.fg }}>{head}</div>
        <div style={{ fontFamily: F.ui, fontSize: 50, color: C.muted, marginTop: 6 }}>{sub}</div>
      </div>
    </div>
  </Rise>
);
export const Layer_: React.FC = () => {
  const id: BeatId = "layer";
  return (
    <Desk>
      <Brand />
      <Rise at={cue(id, "Airwallex")} style={{ position: "absolute", right: 200, top: 170 }}>
        <Kicker>Built on Airwallex</Kicker>
      </Rise>
      <div style={{ position: "absolute", left: 0, right: 0, top: 380, display: "flex", flexDirection: "column", alignItems: "center", gap: 46 }}>
        <Tier at={cue(id, "The agent reads")} n="01" head="The agent reads and investigates" sub="It explains every move, and never sees the raw message" tone={C.accent} />
        <Tier at={cue(id, "policy")} n="02" head="Policy decides" sub="Written in code: the model cannot talk its way past it" tone={C.fg} />
        <Tier at={cue(id, "a person signs")} n="03" head="A person signs what matters" sub="Cards, second payments and anything uncertain" tone={C.warn} />
        <Tier at={cue(id, "every step")} n="04" head="The ledger proves it" sub="Every step sealed to the one before it" tone={C.ok} />
      </div>
    </Desk>
  );
};

/* ── 4. The control room ────────────────────────────────────────────────────────────────────────────────────── */
export const Room: React.FC = () => {
  const id: BeatId = "room";
  const investigate = R("preload", "investigate", css(830, 960, 300, 50));
  const globe = R("preload", "globe", CENTER, 0);
  const cams: Cam[] = [{ at: 0, focus: null }, { at: cue(id, "pinned"), focus: globe, zoom: 1.35, dur: 50 }, { at: cue(id, "One press") - 6, focus: investigate, zoom: 1.9 }];
  return <Screen layers={[at("preload")]} cams={cams} cursor={click(investigate, cue(id, "investigate") - 4, cue(id, "investigate"))}><Sfx id="click" at={cue(id, "investigate")} volume={0.6} /></Screen>;
};

/* ── 5. The six, opened ─────────────────────────────────────────────────────────────────────────────────────── */
export const Loaded: React.FC = () => {
  const id: BeatId = "loaded";
  const modal = R("loaded", "modal", css(950, 640, 50, 50), 70);
  const sf = R("loaded", "sf", css(720, 650, 120, 120), 110);
  const framer = R("loaded", "framer", css(1060, 470, 50, 50), 70);
  const cams: Cam[] = [
    { at: 0, focus: modal, zoom: 2.1, dur: 40 },
    { at: cue(id, "Prime Intellect's"), focus: sf, zoom: 2.0 },
    { at: cue(id, "And then"), focus: framer, zoom: 2.1 },
    { at: voiceEnd(id) - 4, focus: null, dur: 30 },
  ];
  const rings: Ring[] = [
    { from: 8, to: cue(id, "Prime Intellect's") - 4, rect: modal, tone: C.bad },
    { from: cue(id, "Prime Intellect's") + 10, to: cue(id, "And then") - 4, rect: sf, tone: C.bad },
    { from: cue(id, "And then") + 10, to: voiceEnd(id) - 6, rect: framer, tone: C.bad },
  ];
  return <Screen layers={[at("loaded")]} cams={cams} rings={rings} />;
};

/* ── 6. The agent works them ────────────────────────────────────────────────────────────────────────────────── */
export const Agent: React.FC = () => {
  const id: BeatId = "agent";
  const run = R("loaded", "run", css(1500, 300, 400, 44));
  const start = cue(id, "So we let") + 14;
  const files = burstFiles("run");
  const layers: Layer[] = [at("loaded"), ...burstLayers(files, cue(id, "Watch"), voiceEnd(id) - 20), at("worked", voiceEnd(id) - 10)];
  const cams: Cam[] = [{ at: 0, focus: run, zoom: 1.7 }, { at: cue(id, "Watch") - 4, focus: RIGHT_COL, zoom: 1.45, dur: 46 }, { at: cue(id, "asks the policy"), focus: AGENT_COL, zoom: 1.85 }];
  return <Screen layers={layers} cams={cams} cursor={click(run, start, start + 6)}><Sfx id="click" at={start + 6} volume={0.6} /></Screen>;
};

/* ── 7–13. The suppliers, one by one ────────────────────────────────────────────────────────────────────────── */
export const Replicate: React.FC = () => {
  const id: BeatId = "replicate";
  const card = R("replicate-trail", "card", RIGHT_COL, 10);
  return (
    <Screen layers={[at("replicate-trail")]} cams={[{ at: 0, focus: card, zoom: 1.75, dur: 40 }]}>
      <Chapter n="01" supplier={SUPPLIERS.replicate!} problem="Timed out at the bank" outcome="Replaced, paid once" outcomeAt={cue(id, "single replacement")} />
      <Sfx id="chime" at={cue(id, "single replacement") + 4} volume={0.35} />
    </Screen>
  );
};

export const Pi: React.FC = () => {
  const id: BeatId = "pi";
  const card = R("pi-card", "card", RIGHT_COL, 10);
  const landed = R("pi-landed", "card", RIGHT_COL, 10);
  return (
    <Screen layers={[at("pi-card"), at("pi-landed", cue(id, "Moments later"), 16)]} cams={[{ at: 0, focus: card, zoom: 1.75, dur: 40 }, { at: cue(id, "Moments later"), focus: landed, zoom: 1.75 }]}>
      <Chapter n="02" supplier={SUPPLIERS.primeintellect!} problem="Asked to pay it again" outcome="Held · landed once" outcomeAt={cue(id, "holding")} />
      <Sfx id="chime" at={cue(id, "the original lands")} volume={0.35} />
    </Screen>
  );
};

export const Guardrail: React.FC = () => {
  const id: BeatId = "guardrail";
  const test = R("guard-ready", "test", css(1830, 690, 80, 44));
  const press = cue(id, "We tell") + 8;
  const layers: Layer[] = [at("guard-ready"), ...burstLayers(burstFiles("guard"), press + 16, cue(id, "Every attempt")), at("guard-done", cue(id, "Every attempt"))];
  const agentPanel = R("guard-done", "agent", AGENT_COL, 6);
  return (
    <Screen
      layers={layers}
      cams={[{ at: 0, focus: test, zoom: 2.0, dur: 36 }, { at: press + 14, focus: AGENT_COL, zoom: 1.75 }]}
      rings={[{ from: cue(id, "refused"), to: voiceEnd(id) + 10, rect: agentPanel, tone: C.bad }]}
      cursor={click(test, press - 4, press)}
    >
      <Chapter n="02" supplier={SUPPLIERS.primeintellect!} problem="Told to break the rules" outcome="Every attempt refused" outcomeAt={cue(id, "refused")} />
      <Sfx id="click" at={press} volume={0.6} />
      <Sfx id="refuse" at={cue(id, "refused")} volume={0.45} />
    </Screen>
  );
};

export const Framer: React.FC = () => {
  const id: BeatId = "framer";
  const card = R("framer-card-found", "card", RIGHT_COL, 10);
  const report = R("framer-investigation", "report", css(760, 420, 640, 640), 10);
  return (
    <Screen
      layers={[at("framer-card-found"), at("framer-investigation", cue(id, "it investigates"), 16)]}
      cams={[{ at: 0, focus: card, zoom: 1.7, dur: 40 }, { at: cue(id, "it investigates"), focus: report, zoom: 1.55 }]}
      rings={[{ from: cue(id, "Five red flags"), to: voiceEnd(id) + 6, rect: report, tone: C.bad }]}
    >
      <Chapter n="03" supplier={SUPPLIERS.framer!} problem="“Overdue? Pay our new bank”" outcome="Impostor stopped" outcomeAt={cue(id, "not a cent")} />
      <Sfx id="refuse" at={cue(id, "Five red flags")} volume={0.35} />
    </Screen>
  );
};

export const Modal: React.FC = () => {
  const id: BeatId = "modal";
  const cardPanel = R("queue-modal", "card", RIGHT_COL, 14);
  const note = R("queue-modal-note", "note", css(1440, 860, 420, 90), 10);
  const sign = R("queue-modal-note", "sign", css(1600, 980, 280, 44));
  const trail = R("modal-trail", "card", RIGHT_COL, 10);
  const press = cue(id, "authorized");
  return (
    <Screen
      layers={[at("queue-modal"), at("queue-modal-note", cue(id, "A person does") - 6, 14), at("queue-modal-paid", press + 18, 14), at("modal-trail", cue(id, "the charge clears"), 16)]}
      cams={[
        { at: 0, focus: cardPanel, zoom: 1.6, dur: 40 },
        { at: cue(id, "A person does") - 4, focus: { x: note.x, y: note.y, w: note.w, h: sign.y + sign.h - note.y }, zoom: 2.1 },
        { at: press + 18, focus: RIGHT_COL, zoom: 1.4 },
        { at: cue(id, "the charge clears"), focus: trail, zoom: 1.75 },
      ]}
      rings={[{ from: cue(id, "A person does"), to: press - 2, rect: note, tone: C.warn }]}
      cursor={click(sign, press - 4, press)}
    >
      <Chapter n="04" supplier={SUPPLIERS.modal!} problem="Bounced, and past due" outcome="Paid once by Visa, via TAP" outcomeAt={cue(id, "the charge clears")} />
      <Sfx id="click" at={press} volume={0.6} />
      <Sfx id="chime" at={cue(id, "the charge clears") + 6} volume={0.35} />
    </Screen>
  );
};

export const LangChain: React.FC = () => {
  const id: BeatId = "langchain";
  const why = R("queue-lc", "why", css(1440, 700, 420, 100), 12);
  const sign = R("queue-lc-review", "sign", css(1680, 980, 200, 44));
  const press = cue(id, "releases");
  return (
    <Screen
      layers={[at("queue-lc"), at("queue-lc-review", cue(id, "writes down why") + 10, 12), at("queue-lc-signed", press + 16, 14)]}
      cams={[{ at: 0, focus: why, zoom: 1.9, dur: 40 }, { at: cue(id, "writes down why") + 8, focus: { x: why.x, y: why.y, w: why.w, h: sign.y + sign.h - why.y }, zoom: 1.6 }, { at: press + 16, focus: RIGHT_COL, zoom: 1.35 }]}
      rings={[{ from: cue(id, "writes down why"), to: press - 4, rect: why, tone: C.warn }]}
      cursor={click(sign, press - 4, press)}
    >
      <Chapter n="05" supplier={SUPPLIERS.langchain!} problem="Returned as a possible duplicate" outcome="Released in writing" outcomeAt={press + 10} />
      <Sfx id="click" at={press} volume={0.6} />
    </Screen>
  );
};

export const Fal: React.FC = () => {
  const id: BeatId = "fal";
  const card = R("fal-card", "card", RIGHT_COL, 10);
  const received = R("fal-card", "received", css(1300, 900, 200, 44));
  const press = cue(id, "click");
  return (
    <Screen layers={[at("fal-card"), at("fal-received", press + 14, 14)]} cams={[{ at: 0, focus: card, zoom: 1.75, dur: 40 }]} cursor={click(received, press - 4, press)}>
      <Chapter n="06" supplier={SUPPLIERS.fal!} problem="Paid, but says it never arrived" outcome="Confirmed received" outcomeAt={press + 10} />
      <Sfx id="click" at={press} volume={0.6} />
      <Sfx id="chime" at={press + 12} volume={0.3} />
    </Screen>
  );
};

/* ── 14. Everything settles ─────────────────────────────────────────────────────────────────────────────────── */
export const Settle: React.FC = () => {
  const id: BeatId = "settle";
  const files = burstFiles("settle");
  const recordAt = cue(id, "Every move");
  const dialog = R("history", "dialog", CENTER, 10);
  const layers: Layer[] = [...burstLayers(files.length > 0 ? files : [shotFile("all-green")], 0, cue(id, "certifies itself")), at("all-green", cue(id, "certifies itself"), 14), at("history", recordAt, 16)];
  return (
    <Screen layers={layers} cams={[{ at: 0, focus: CENTER, zoom: 1.25, dur: 50 }, { at: recordAt, focus: dialog, zoom: 1.5 }]}>
      <Sfx id="chime" at={cue(id, "certifies itself") + 6} volume={0.4} />
    </Screen>
  );
};

/* ── 15. Close ──────────────────────────────────────────────────────────────────────────────────────────────── */
export const Close: React.FC = () => {
  const f = useCurrentFrame();
  const id: BeatId = "close";
  const tagAt = cue(id, "Tessera");
  const lon = -96 + interpolate(f, [0, beatFrames(id)], [-8, 14], clamp);
  const fade = interpolate(f, [beatFrames(id) - 40, beatFrames(id)], [1, 0], clamp);
  const globeOut = ease(interpolate(f, [tagAt - 10, tagAt + 30], [1, 0.25], clamp));
  return (
    <Desk glow="rgba(51,214,138,0.12)">
      <AbsoluteFill style={{ opacity: fade }}>
        <AbsoluteFill style={{ opacity: globeOut }}>
          <NativeGlobe radius={760} cx={W * 0.68} cy={H * 0.54} lon={lon} lat={31} pins={pinsFor(() => C.ok, () => 0, false)} />
        </AbsoluteFill>
        <div style={{ position: "absolute", left: 300, top: 640, display: "flex", flexDirection: "column", gap: 40, opacity: interpolate(f, [tagAt - 14, tagAt + 6], [1, 0], clamp), filter: `blur(${interpolate(f, [tagAt - 14, tagAt + 6], [0, 18], clamp)}px)` }}>
          {(
            [
              ["Wait when", "waiting is right", C.accent, cue(id, "Wait")],
              ["Pay once,", "when it's safe", C.ok, cue(id, "Pay once")],
              ["Hand everything else", "to a person", C.warn, cue(id, "Hand everything")],
            ] as const
          ).map(([a, b, tone, t]) => (
            <Rise key={a} at={t} style={{ fontFamily: F.ui, fontSize: 120, fontWeight: 600, letterSpacing: -4, color: C.fg, lineHeight: 1.05 }}>
              {a} <span style={{ color: tone }}>{b}</span>
            </Rise>
          ))}
        </div>
        <Rise at={tagAt + 4} dur={28} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 44 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 48, padding: "60px 90px", borderRadius: 80, background: "rgba(10,11,13,0.82)", backdropFilter: "blur(40px)", border: "2px solid rgba(255,255,255,0.08)" }}>
            <Img src={staticFile("brand/tessera-mark.png")} style={{ width: 190, height: 190 }} />
            <div>
              <div style={{ fontFamily: F.ui, fontSize: 170, fontWeight: 600, letterSpacing: -6, color: C.fg, lineHeight: 1 }}>Tessera</div>
              <div style={{ fontFamily: F.ui, fontSize: 64, color: C.muted, marginTop: 16 }}>Money that moves once, and can prove it.</div>
            </div>
          </div>
        </Rise>
      </AbsoluteFill>
      <Sfx id="rise" at={tagAt - 30} volume={0.35} />
    </Desk>
  );
};
