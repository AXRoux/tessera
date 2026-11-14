// Single source of truth for the narration. The audio generator reads it, and the video reads the
// generated timings (src/timings.json) to size every scene to its voice-over.
export const VOICE_ID = "cjVigY5qzO86Huf0OWal"; // Eric: smooth, trustworthy
export const TTS_MODEL = "eleven_multilingual_v2";

export type SceneId = "hook" | "idea" | "room" | "incident" | "webhook" | "agent" | "break" | "visa" | "proof" | "outro";

export const SCENES: { id: SceneId; text: string }[] = [
  {
    id: "hook",
    text: "A supplier writes: the transfer never arrived. Your agent has three choices. Wait. Replace. Or escalate. Replace too early, and you have paid twice. Trust an email that says we changed banks, and you have paid a fraudster. Trust a bank that says paid, and you can be wrong for days.",
  },
  {
    id: "idea",
    text: "This is Tessera, built on the Airwallex sandbox. The model reads the messy email. A few hundred lines of plain, tested code decide what is allowed. Nothing the agent says, not a clever prompt, not a retry, not a crash, can argue with that code.",
  },
  {
    id: "room",
    text: "Here is the control room. Seven supplier payouts on Airwallex, each one a different kind of trouble. Every invoice shows its next safe move, what is waiting on you, and what the agent will work.",
  },
  {
    id: "incident",
    text: "Watch one incident change. The goal: get this supplier paid once. The transfer is in flight, inside its window, so the plan is wait. Then an email arrives, asking to change bank details, with instructions aimed at the assistant. Claude reads it through a quarantined reader that returns facts, never text. The decision flips: hand it to a person, critical, with every blocked action and the reason why.",
  },
  {
    id: "webhook",
    text: "Sometimes nobody has to ask. Airwallex sends a signed webhook. Tessera does not trust the message, it re-reads the transfer. The decision flips from wait to replace, and the agent wakes for that one incident, under the same rules, and pays the replacement the code allows.",
  },
  {
    id: "agent",
    text: "Now seven incidents, each wrong in a different way. Claude assesses every one, and acts only on what the code allows. It replaces the transient failure. It escalates the possible duplicate and the bank change. It drafts replies for a person to send, and certifies the paid one. One replacement had no money behind it, so the code computed the shortfall, and Claude converted exactly that amount, then paid.",
  },
  {
    id: "break",
    text: "Now the same toolbox, the same model, told to get a supplier paid twice, forge a message, and certify a payment still in flight. Every move is refused. By code, not by the model being polite. The model cannot argue with a database.",
  },
  {
    id: "visa",
    text: "Agents also need to buy things. So every purchase gets its own single-use Visa card, issued by Airwallex. Code checks the request, a named person signs it, and the signed terms become the card's own controls. The agent pays through Visa's Trusted Agent Protocol: it signs the checkout, and the merchant verifies that signature before it charges. A charge the card was not signed for, the network declines. And the moment a charge clears, Tessera proves it against what the person signed. Charged by a different merchant? It is flagged, even though the card let it through.",
  },
  {
    id: "proof",
    text: "Fifty adversarial attacks, all held. Six hundred twenty tests. Ninety-four guards, each removed one at a time to prove something breaks. And on the real sandbox, we kill the process with signal nine in the middle of a payment, restart it, and Airwallex holds exactly one transfer.",
  },
  {
    id: "outro",
    text: "It speaks MCP, with no SDK. Claude Code, Codex, Cursor, Gemini, Copilot and Hermes Agent all get the same thirteen tools, and the same refusals. And it is live: sign up, pick your agent, and bring your own Airwallex sandbox keys. Sandbox only, tamper-evident, not tamper-proof, and the limits are written down. Tessera. Money that moves once, and can prove it.",
  },
];

export const SFX = {
  whoosh: "Short soft cinematic whoosh transition, clean and modern, tech product video",
  chime: "Subtle positive digital confirmation chime, two soft rising notes, clean",
  refuse: "Short deep muted digital denied thud with a low error tone, not harsh, product UI",
  tick: "Single crisp soft UI click, minimal",
  impact: "Deep cinematic impact hit with a short reverb tail, tech trailer",
  keys: "Fast soft mechanical keyboard typing burst, quiet room",
  alert: "Soft warning pulse, two low electronic beeps, subtle",
  tap: "Contactless card tap on a payment terminal, one short clean confirmation beep, modern product UI sound",
} as const;
export type SfxId = keyof typeof SFX;

export const MUSIC_PROMPT =
  "Minimal, modern, confident electronic underscore for a fintech product demo. Steady soft pulse, warm sub bass, gentle arpeggiated synth, light percussion, subtle tension that resolves. Instrumental, no vocals, no drops, suitable to sit quietly under a voice-over.";
