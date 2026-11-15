// Narration for the Ultramock launch film. One line per beat: the line is spoken over its own shot, so the
// storyboard sizes each shot to the recorded line (generator writes per-line mp3s plus a timings file).
// Voice: female, Brazilian, speaking English. Written to be said, not read: contractions, breath, one idea a line.

export type LaunchLineId =
  | "hook"
  | "choice"
  | "cost"
  | "what"
  | "rule"
  | "once"
  | "attacks"
  | "visa"
  | "proof"
  | "signoff";

export const LAUNCH_LINES: { id: LaunchLineId; text: string; onScreen: string }[] = [
  {
    id: "hook",
    text: "A supplier writes: the payment never arrived.",
    onScreen: "The payment never arrived.",
  },
  {
    id: "choice",
    text: "Your agent has three ways to answer — wait, send it again, or ask a person.",
    onScreen: "Wait. Replace. Escalate.",
  },
  {
    id: "cost",
    text: "Send it too soon, and the supplier is paid twice. Trust the wrong email, and the money walks away.",
    onScreen: "Paid twice.\nPaid a stranger.",
  },
  {
    id: "what",
    text: "Tessera sits in between. Your agent reads the messy email, chases the failed transfer, drafts the reply.",
    onScreen: "The agent reads.",
  },
  {
    id: "rule",
    text: "Policy decides what is actually allowed. A person signs what matters. And nothing moves unsealed.",
    onScreen: "Policy decides.\nYou sign.",
  },
  {
    id: "once",
    text: "When Airwallex reports a cancellation, Tessera does not take its word — it checks, then pays the replacement. Once.",
    onScreen: "Replaced once, never twice.",
  },
  {
    id: "attacks",
    text: "We threw fifty deliberate attacks at it. Every one was held. The model can try anything; it cannot unlock a payment.",
    onScreen: "50 attacks. 50 held.",
  },
  {
    id: "visa",
    text: "Even the buying is guarded: every purchase gets its own single-use Visa card, limits built from what a person approved — outside that, the network declines.",
    onScreen: "Single-use Visa.\nSigned terms.",
  },
  {
    id: "proof",
    text: "Six hundred twenty-three tests. Ninety-four safeguards, each pulled out to prove something breaks. Kill the process mid-payment — Airwallex holds exactly one transfer.",
    onScreen: "623 tests.\n94 safeguards.",
  },
  {
    id: "signoff",
    text: "Tessera. Money that moves once — and can prove it.",
    onScreen: "Money that moves once.",
  },
];
