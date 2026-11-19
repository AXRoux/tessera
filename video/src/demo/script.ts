// Demo Day film: one supplier whose payment went wrong, followed from the first email to the certificate.
// Every screen is a 2x capture of the console on the real Airwallex sandbox (public/img/demo, ACME-1041-8VL2).
// The narration is the single source of truth: the audio generator voices each beat, and both the Ultramock
// storyboard (scripts/build-ultramock.ts) and the Remotion composition are cut to the recorded words.

export const VOICE_ID = "cjVigY5qzO86Huf0OWal"; // Eric, the same voice as the submission film
export const TTS_MODEL = "eleven_multilingual_v2";

export type BeatId =
  | "cold"
  | "stakes"
  | "layer"
  | "room"
  | "knows"
  | "waits"
  | "evidence"
  | "permits"
  | "replace"
  | "retry"
  | "status"
  | "human"
  | "close";

export const BEATS: { id: BeatId; text: string }[] = [
  {
    id: "cold",
    text: "Nine in the morning. A supplier writes: invoice ten forty-one, twenty-five dollars. It never arrived. Your AI agent has to answer, and it has three moves. Wait. Pay again. Or hand it to a person.",
  },
  {
    id: "stakes",
    text: "Every wrong move costs money. Pay again while the first transfer is still moving, and the supplier is paid twice. Believe an email that says, we changed banks, and you have paid a fraudster. An agent holding raw payment keys can do both, in seconds.",
  },
  {
    id: "layer",
    text: "Tessera is the layer between your agents and your treasury, built on Airwallex. The model reads and explains. Policy, written in code, decides what is allowed. A person signs what matters. And every step is sealed into a ledger that breaks, visibly, if anyone edits it.",
  },
  {
    id: "room",
    text: "This is the control room, running on the real Airwallex sandbox. Eight supplier payouts, each in a different kind of trouble. We will follow one of them, all the way through. Invoice ten forty-one, to Northwind Supply.",
  },
  {
    id: "knows",
    text: "Here is what Tessera knows. Twenty-five dollars, on the local US rail. Approved by a named person, and sealed in the ledger before a cent moved. Airwallex has the transfer as sent. And Northwind's email sits in the inbox. Only its fingerprint goes in the ledger, and nothing it says can unlock a payment.",
  },
  {
    id: "waits",
    text: "So Tessera recommends: hold steady. The transfer has been processing for three minutes, of an expected five. It may still land. Replace is held back, and the reason is in plain English: the original payment may still arrive. Replacing it could pay the supplier twice. The supplier is unhappy. The answer is still, wait.",
  },
  {
    id: "evidence",
    text: "Then the bank answers. On the sandbox, we play the bank with Airwallex's own simulator. The transfer fails. Channel timeout, code nine one four oh two. And Airwallex cancels it. Tessera does not take the event's word for it, or the supplier's. It reads the transfer back from Airwallex itself, seals what it found on the chain, and reassesses.",
  },
  {
    id: "permits",
    text: "Now the decision changes. Replace the payment. Nine one four oh two is a temporary fault on the payment rails. The original is cancelled. The money is back in the wallet. And twenty-five dollars is inside the automatic limit. Every one of those is a fact Airwallex confirmed, not something anyone claimed.",
  },
  {
    id: "replace",
    text: "One press. Tessera seals the intent in the ledger first, then creates the replacement under a fresh request ID. The original stays cancelled. Two attempts on this invoice, and exactly one of them alive.",
  },
  {
    id: "retry",
    text: "Now the question that matters. What if it is pressed again? A double click. A retry storm. An agent that loses track. We send the same replace request straight to the API. Refused. A conflict, written to the ledger under the name of whoever asked: the new transfer is in flight, so waiting is the right call. And underneath the policy, the database itself allows one open payment per invoice. Never two.",
  },
  {
    id: "status",
    text: "Here is where the payment actually stands. Airwallex reports the replacement paid. Tessera still does not close on the bank's say-so. A bank can return a payment, so it waits out a hold window. Then it reconciles every wallet line against Airwallex. Twenty-five dollars received. Six dollars of fees across two attempts. Certified, with a fingerprint anyone can check.",
  },
  {
    id: "human",
    text: "And here is what still needs a person. Northwind's email has not been answered. Tessera never writes to a supplier on its own: a person replies. And the queue says it plainly. Four decisions are yours. One is a duplication return, where the supplier may already hold the money. No agent, and no policy, can release that. Only a named person, in writing.",
  },
  {
    id: "close",
    text: "Wait, when waiting is right. Replace, when the bank proves it is safe. Never twice. And a person, for everything else. Tessera. Money that moves once, and can prove it.",
  },
];

export const SFX = {
  whoosh: "Short soft cinematic whoosh transition, clean and modern, tech product video",
  chime: "Subtle positive digital confirmation chime, two soft rising notes, clean",
  refuse: "Short deep muted digital denied thud with a low error tone, not harsh, product UI",
  tick: "Single crisp soft UI click, minimal",
  alert: "Soft warning pulse, two low electronic beeps, subtle",
} as const;
export type SfxId = keyof typeof SFX;

export const MUSIC_PROMPT =
  "Calm, premium, minimal electronic underscore for a fintech product film. Warm sub bass, soft felt piano motif, gentle pulse, light tension in the middle that resolves warmly at the end. Instrumental, no vocals, no drops, sits quietly under a voice-over.";
