import React from "react";
import { Composition, Still } from "remotion";
import { Banner } from "./Banner";
import { FPS, H, TOTAL, W } from "./lib";
import { Video } from "./Video";

export const Root: React.FC = () => (
  <>
    <Composition id="Tessera" component={Video} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
    <Still id="Banner" component={Banner} width={2000} height={719} />
  </>
);
