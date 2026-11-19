import React from "react";
import { Composition, Still } from "remotion";
import { Banner } from "./Banner";
import { FPS, H, TOTAL, W } from "./lib";
import { Video } from "./Video";
import { Film } from "./issues/Film";
import { FPS as FILM_FPS, H as FILM_H, TOTAL as FILM_TOTAL, W as FILM_W } from "./issues/kit";

export const Root: React.FC = () => (
  <>
    <Composition id="Tessera" component={Video} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
    <Composition id="SupplierIssues" component={Film} durationInFrames={FILM_TOTAL} fps={FILM_FPS} width={FILM_W} height={FILM_H} defaultProps={{ captions: true }} />
    <Still id="Banner" component={Banner} width={2000} height={719} />
  </>
);
