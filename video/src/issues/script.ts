// The supplier-issues film: a five-minute walkthrough of the control room, every screen a 4K capture of the real
// console on the Airwallex sandbox (public/film, scripts/capture-issues.ts). The narration is the single source of
// truth: each beat is voiced on its own (with word timestamps), and every scene is cut to its words.
//
// Written to be spoken: contractions, questions, dashes and semicolons that let a thought run on, so the voice
// breathes like a person explaining something they care about, not a list being read out.

export const VOICE_ID = "cjVigY5qzO86Huf0OWal"; // Eric: the voice of the earlier Tessera films
export const TTS_MODEL = "eleven_multilingual_v2";

export type BeatId =
  | "open"
  | "stakes"
  | "layer"
  | "room"
  | "loaded"
  | "agent"
  | "replicate"
  | "pi"
  | "guardrail"
  | "framer"
  | "modal"
  | "langchain"
  | "fal"
  | "settle"
  | "close";

export const BEATS: { id: BeatId; text: string }[] = [
  {
    id: "open",
    text: "Last night, six payments went out to the suppliers that keep this company running — compute, models, the tools the team builds with. By nine this morning, every one of them was stuck, and each in its own way.",
  },
  {
    id: "stakes",
    text: "This is exactly where an AI agent can do real damage. Pay again while the first transfer is still moving, and you've paid twice; believe an email that says “we've changed banks”, and you've paid a fraudster. Hand an agent raw payment keys, and it can do both in a matter of seconds.",
  },
  {
    id: "layer",
    text: "Tessera is the layer between your agents and your treasury, built on Airwallex. The agent reads, investigates and explains; policy, written in code, decides what's allowed; a person signs what matters — and every step is sealed into a ledger that shows, plainly, if anyone ever edits it.",
  },
  {
    id: "room",
    text: "This is the control room. Six supplier issues are waiting, each one pinned where that supplier actually works: the Bay Area, New York, Amsterdam. One press, and we investigate.",
  },
  {
    id: "loaded",
    text: "Modal's transfer bounced at the bank, and they're now past due. Prime Intellect's payment is still in transit, yet they want it sent again. Replicate's timed out; LangChain's came back as a possible duplicate; fal says theirs never arrived. And then there's an email that claims to be from Framer.",
  },
  {
    id: "agent",
    text: "So we let the agent work all six. Watch what it does before it touches any money: it reads each supplier's email through a quarantined reader, checks the transfer with Airwallex itself, and asks the policy what's allowed — only then does it act.",
  },
  {
    id: "replicate",
    text: "Replicate is the simple one. Airwallex confirms the money is back and the fault was temporary, so the agent sends a single replacement, inside its automatic limit, without waiting on anyone.",
  },
  {
    id: "pi",
    text: "Prime Intellect is the trap. They're asking for a second payment — but the first one is still moving, and paying now could pay them twice. So the agent holds, drafts a calm reply for a person to send, and waits. Moments later, the original lands; holding was the right call.",
  },
  {
    id: "guardrail",
    text: "And what if someone pushes? We tell the very same agent to break the rules on that invoice: pay it again, pay it by card as well, certify it early. Every attempt is refused — not because the model is being polite, but because the code says no.",
  },
  {
    id: "framer",
    text: "Framer's email is the dangerous one. Overdue, new bank, pay here instead, and a line written for the assistant itself. The agent doesn't argue with it; it investigates. The sender is a look-alike domain, the account isn't the one on file, and the invoice was already paid. Five red flags, and not a cent moves.",
  },
  {
    id: "modal",
    text: "Modal is past due, and another bank transfer would take too long. So the agent asks for a single-use Visa card, for exactly this invoice and payable only to Modal — but it can't sign that card. A person does. The moment it's authorized, the agent pays Modal's checkout through Visa's Trusted Agent Protocol, and the charge clears against the very terms that were signed.",
  },
  {
    id: "langchain",
    text: "LangChain's payment came back as a possible duplicate, which means they may already have the money. That's never the agent's call. A person checks with LangChain, writes down why, and releases a second payment, in writing.",
  },
  {
    id: "fal",
    text: "fal was paid; they simply couldn't find it. Rather than pay again, the agent drafted proof of payment — and once fal confirms it arrived, a single click settles it.",
  },
  {
    id: "settle",
    text: "And then, one by one, it all settles. Each issue certifies itself once the money has landed, held through its window, and been reconciled line by line against Airwallex. Every move — the agent's, the bank's and ours — is on the record, in order, for anyone to check.",
  },
  {
    id: "close",
    text: "Wait when waiting is right. Pay once, when it's safe. Hand everything else to a person. Tessera: money that moves once, and can prove it.",
  },
];

export const SFX = {
  whoosh: "Very soft, airy cinematic whoosh for a premium product film transition, clean, no rumble",
  click: "Single soft premium trackpad click, crisp and quiet, product UI",
  chime: "Gentle positive confirmation chime, two soft rising glassy notes, minimal",
  refuse: "Soft low muted digital denial tone, short, calm, not harsh, product UI",
  rise: "Subtle warm shimmering riser, two seconds, swelling into calm, cinematic and minimal",
} as const;
export type SfxId = keyof typeof SFX;

export const MUSIC_PROMPT =
  "Premium, calm and confident minimal electronic score for a fintech product film. Warm analog pads, soft felt piano motif, a gentle steady pulse around 92 BPM, quiet tension through the middle that resolves warmly and optimistically at the end. Instrumental, no vocals, no drops, mixed to sit quietly under a voice-over.";
