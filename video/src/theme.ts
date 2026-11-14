import { loadFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadZen } from "@remotion/google-fonts/ZenDots";

// Same three families as the Tessera console (web/app/layout.tsx).
export const F = {
  display: loadZen().fontFamily,
  body: loadArchivo("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] }).fontFamily,
  mono: loadMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] }).fontFamily,
};

export const C = {
  ink: "#0b0d12",
  panel: "#12151d",
  blue: "#1f4dff",
  soft: "#8fa6ff",
  paper: "#ffffff",
  muted: "rgba(255,255,255,0.58)",
  line: "rgba(255,255,255,0.14)",
  red: "#ff5c6c",
  green: "#3ddc97",
  amber: "#ffc857",
};
