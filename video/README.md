# Tessera video (Remotion)

A 3:42, 1080p explainer with ElevenLabs voice-over, sound effects and a music bed, mastered to -14 LUFS. Every sound is generated; the screens are real: 2x captures of the current console (`public/img/v2`, from the offline demo, shown through a moving camera), the sign-up card plates generated with fal.ai (`public/cards`), and the real tool calls and refusals from the recorded runs (`docs/img`).

```sh
cd video && bun install
echo "ELEVENLABS_API_KEY=sk_..." > .env   # git-ignored
bun run audio      # voice (with word timestamps), SFX, music -> public/audio, src/timings.json
bun run studio     # preview and scrub
bun run render     # -> out/tessera.mp4
# then master the loudness for YouTube (-14 LUFS, video stream copied untouched):
# ffmpeg -i out/tessera.mp4 -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 256k out/tessera-14.mp4
```

- **Narration** lives in `src/script.ts`. Change a line, run `bun run audio --force`, and every scene resizes itself to its voice.
- **Sync**: `scripts/generate-audio.ts` keeps ElevenLabs' character timestamps. Scenes call `cue(sceneId, "phrase")` (`src/lib.ts`) to start an animation on the exact word, and the captions highlight the spoken word from the same data.
- **APIs used**: `text-to-speech/:voice/with-timestamps` (voice `Eric`, `eleven_multilingual_v2`), `sound-generation`, `music`.
