import React from "react";
import { AbsoluteFill, interpolate, Sequence, staticFile } from "remotion";
import { Audio } from "@remotion/media";
import { sceneFrames, sceneStart, timings, TOTAL } from "./lib";
import { SCENES, type SceneId } from "./script";
import { Agent } from "./scenes/Agent";
import { Break } from "./scenes/Break";
import { Hook } from "./scenes/Hook";
import { Idea } from "./scenes/Idea";
import { Incident } from "./scenes/Incident";
import { Outro } from "./scenes/Outro";
import { Proof } from "./scenes/Proof";
import { Room } from "./scenes/Room";
import { Visa } from "./scenes/Visa";
import { Webhook } from "./scenes/Webhook";

const COMPONENTS: Record<SceneId, React.FC> = {
  hook: Hook,
  idea: Idea,
  room: Room,
  incident: Incident,
  webhook: Webhook,
  agent: Agent,
  break: Break,
  visa: Visa,
  proof: Proof,
  outro: Outro,
};

export const Video: React.FC = () => (
  <AbsoluteFill style={{ background: "#0b0d12" }}>
    {SCENES.map((s) => {
      const Scene = COMPONENTS[s.id];
      return (
        <Sequence key={s.id} from={sceneStart(s.id)} durationInFrames={sceneFrames(s.id)} name={s.id}>
          <Scene />
        </Sequence>
      );
    })}
    {/* Music bed from ElevenLabs, kept well under the voice. */}
    <Audio
      src={staticFile(timings.music.file)}
      trimAfter={TOTAL}
      volume={(f) => interpolate(f, [0, 45, TOTAL - 90, TOTAL], [0, 0.13, 0.13, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
    />
  </AbsoluteFill>
);
