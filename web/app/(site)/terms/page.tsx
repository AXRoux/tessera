import type { Metadata } from "next";
import { LegalShell, type LegalSection } from "@/components/site/legal";

export const metadata: Metadata = {
  title: "Terms of Service · Tessera",
  description:
    "What Tessera is, what sandbox-only means, and the short agreement behind the sign-up checkbox: your workspace, your keys, fair use, and how it ends.",
};

const SECTIONS: LegalSection[] = [
  {
    heading: "What this is",
    body: (
      <p>
        Tessera is a control layer for AI agents that work supplier payouts on the Airwallex sandbox. The agent reads and
        explains, policy written in code decides what is allowed, a person signs what matters, and every move is written to
        a hash-chained ledger. Creating a workspace means you accept these terms.
      </p>
    ),
  },
  {
    heading: "Sandbox only",
    body: (
      <p>
        No real money moves here. Balances, transfers and cards are Airwallex sandbox objects, and the offline rehearsal
        runs on a simulator. Treat the numbers as real-looking, not as money you can miss.
      </p>
    ),
  },
  {
    heading: "Your workspace and your keys",
    body: (
      <p>
        You bring your own Airwallex sandbox credentials, and, if you want the built-in agent, your own model key. They are
        stored encrypted (see the <a href="/privacy">Privacy Policy</a>) and you stay responsible for those accounts. One
        workspace per sign-up, for one person.
      </p>
    ),
  },
  {
    heading: "What the agent may do",
    body: (
      <p>
        The agent can only reach fourteen typed tools, and only where policy allows. Anything risky waits for a named person
        with a written reason. Drafts to suppliers are prepared for you; Tessera never sends mail on its own.
      </p>
    ),
  },
  {
    heading: "Fair use",
    body: (
      <p>
        Keep your password to yourself, do not hammer the shared deployment, and do not point it at sandbox accounts whose
        keys you do not hold. The sign-up limit exists so real people can still get a workspace.
      </p>
    ),
  },
  {
    heading: "Availability and changes",
    body: (
      <p>
        This is a hackathon build: it may change, pause or be replaced without notice, and it comes with no guarantee of
        uptime. When these terms change, the date above changes with them.
      </p>
    ),
  },
  {
    heading: "Liability",
    body: (
      <p>
        The service is provided as is, without warranty. Because no real money moves, the worst case is small by
        construction: the most you can lose is a ledger you have to look at twice.
      </p>
    ),
  },
  {
    heading: "Ending it",
    body: (
      <p>
        Sign out whenever you like. Ask and your workspace is deleted, account, keys and ledger together. Deleting a
        workspace never touches your own Airwallex sandbox account.
      </p>
    ),
  },
  {
    heading: "Contact",
    body: (
      <p>
        Questions or bugs: open an issue at{" "}
        <a href="https://github.com/AXRoux/tessera/issues" target="_blank" rel="noopener noreferrer">
          github.com/AXRoux/tessera
        </a>
        .
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalShell
      label="Terms"
      title="Terms of Service"
      standfirst="The short agreement behind the sign-up checkbox: what Tessera is, what sandbox means here, and what each side owes the other."
      updated="15 November 2026"
      sections={SECTIONS}
      sibling={{ href: "/privacy", label: "Privacy" }}
    />
  );
}
