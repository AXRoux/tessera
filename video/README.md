# Tessera video (Remotion)

A 2:45, 1080p explainer with ElevenLabs voice-over, sound effects and a music bed. Every sound is generated; the screens are the real screenshots in `docs/img` plus the real tool calls and refusals from the recorded runs.

```sh
cd video && bun install
echo "ELEVENLABS_API_KEY=sk_..." > .env   # git-ignored
bun run audio      # voice (with word timestamps), SFX, music -> public/audio, src/timings.json
bun run studio     # preview and scrub
bun run render     # -> out/tessera.mp4
```

- **Narration** lives in `src/script.ts`. Change a line, run `bun run audio --force`, and every scene resizes itself to its voice.
- **Sync**: `scripts/generate-audio.ts` keeps ElevenLabs' character timestamps. Scenes call `cue(sceneId, "phrase")` (`src/lib.ts`) to start an animation on the exact word, and the captions highlight the spoken word from the same data.
- **APIs used**: `text-to-speech/:voice/with-timestamps` (voice `Eric`, `eleven_multilingual_v2`), `sound-generation`, `music`.
