import type { Metadata } from "next";
import { LegalShell, type LegalSection } from "@/components/site/legal";

export const metadata: Metadata = {
  title: "Privacy Policy · Tessera",
  description:
    "What Tessera stores (account, encrypted keys, the ledger), the only two things that leave the machine, and how to have a workspace deleted.",
};

const SECTIONS: LegalSection[] = [
  {
    heading: "The short version",
    body: (
      <p>
        A small, fixed set of data, held for one reason: running your workspace. No analytics, no ad trackers, no
        third-party cookies.
      </p>
    ),
  },
  {
    heading: "What is stored",
    body: (
      <p>
        Your account: name, email, a password hash (Better Auth does the hashing) and your sessions. Your workspace: the
        keys you connect, encrypted with the deployment's master key. Your ledger: invoices, transfers, events and
        certificates, in a SQLite file that belongs to your workspace alone.
      </p>
    ),
  },
  {
    heading: "What leaves the machine",
    body: (
      <p>
        Only calls you configure: Airwallex, with your sandbox keys, and your model provider, which sees the supplier
        message text and the ledger facts the tools return so it can read and explain them. The offline rehearsal calls
        nothing at all.
      </p>
    ),
  },
  {
    heading: "Cookies",
    body: (
      <p>
        Two, both first-party: a session cookie (httpOnly, so the page itself never reads it) and a theme cookie that
        remembers light or dark.
      </p>
    ),
  },
  {
    heading: "Who can see it",
    body: (
      <p>
        The operator of the deployment you signed up on, because someone has to hold the database. Keys are encrypted at
        rest and passwords are hashed, and the model never sees a credential: it sees booleans and facts.
      </p>
    ),
  },
  {
    heading: "When the terms were accepted",
    body: (
      <p>
        Your account records the moment you ticked the checkbox on the sign-up card, so the agreement has a date attached
        to it rather than a shrug.
      </p>
    ),
  },
  {
    heading: "How long it is kept",
    body: (
      <p>
        The ledger keeps history for as long as your workspace exists; that is its job. Sign out whenever you like, and
        nothing is deleted behind your back.
      </p>
    ),
  },
  {
    heading: "Your choices",
    body: (
      <p>
        Change or remove your keys from the workspace page, sign out from anywhere, and ask what is held about you. A
        deletion request takes the whole workspace with it.
      </p>
    ),
  },
  {
    heading: "Contact",
    body: (
      <p>
        Anything privacy-related: open an issue at{" "}
        <a href="https://github.com/AXRoux/tessera/issues" target="_blank" rel="noopener noreferrer">
          github.com/AXRoux/tessera
        </a>
        .
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalShell
      label="Privacy"
      title="Privacy Policy"
      standfirst="What Tessera stores, why each piece exists, and the very short list of places any of it goes."
      updated="15 November 2026"
      sections={SECTIONS}
      sibling={{ href: "/terms", label: "Terms" }}
    />
  );
}
