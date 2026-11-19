import React from "react";
import { AbsoluteFill, interpolate, Sequence, staticFile } from "remotion";
import { Audio } from "@remotion/media";
import { Captions, Sfx } from "./components";
import { beatFrames, beatStart, C, leadOf, timings, TOTAL } from "./kit";
import { BEATS, type BeatId } from "./script";
import { Agent, Close, Fal, Framer, Guardrail, LangChain, Layer_, Loaded, Modal, Open, Pi, Replicate, Room, Settle, Stakes } from "./scenes";

const SCENES: Record<BeatId, React.FC> = {
  open: Open, stakes: Stakes, layer: Layer_, room: Room, loaded: Loaded, agent: Agent, replicate: Replicate, pi: Pi,
  guardrail: Guardrail, framer: Framer, modal: Modal, langchain: LangChain, fal: Fal, settle: Settle, close: Close,
};

/** Scenes whose words are already on screen as type: no caption over them. */
const NO_CAPTIONS: BeatId[] = ["stakes", "close"];

/**
 * The supplier-issues film, 4K. Each beat is a scene cut to its own voice-over; the music bed runs under the whole film,
 * a soft whoosh opens each scene, and captions follow the voice word by word (`captions` turns them off).
 */
export const Film: React.FC<{ captions?: boolean }> = ({ captions = true }) => (
  <AbsoluteFill style={{ background: C.canvas }}>
    {BEATS.map((b, i) => {
      const Scene = SCENES[b.id];
      return (
        <Sequence key={b.id} from={beatStart(b.id)} durationInFrames={beatFrames(b.id)} name={b.id}>
          <Scene />
          <Sequence from={leadOf(b.id)} layout="none">
            <Audio src={staticFile(timings.beats[b.id].file)} volume={1} />
          </Sequence>
          {i > 0 ? <Sfx id="whoosh" at={0} volume={0.18} /> : null}
          {captions && !NO_CAPTIONS.includes(b.id) ? <Captions words={timings.beats[b.id].words} lead={leadOf(b.id)} /> : null}
        </Sequence>
      );
    })}
    <Audio
      src={staticFile(timings.music.file)}
      trimAfter={TOTAL}
      volume={(f) => interpolate(f, [0, 60, TOTAL - 150, TOTAL], [0, 0.11, 0.11, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
    />
  </AbsoluteFill>
);
