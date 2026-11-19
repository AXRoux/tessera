// Renders single frames of the SupplierIssues film, bundling once: node scripts/render-stills.mjs 300 900 ...
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const comp = await selectComposition({ serveUrl, id: "SupplierIssues" });
const frames = process.argv.slice(2).map(Number);
for (const f of frames) {
  await renderStill({ composition: comp, serveUrl, frame: f, output: `/tmp/tessera/still-${f}.jpg`, imageFormat: "jpeg", scale: 0.4 });
  console.log("ok", f);
}
