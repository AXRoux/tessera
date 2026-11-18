import type { Metadata } from "next";
import { LegalCallout, LegalShell, LegalTable, type LegalGlance, type LegalSection } from "@/components/site/legal";

export const metadata: Metadata = {
  title: "Terms of Service · Tessera",
  description:
    "The agreement for using Tessera: a sandbox-only control layer for AI agents that work supplier payouts on Airwallex. Eligibility, your keys, what the agent may do, acceptable use, liability and how it ends.",
};

const ISSUES = "https://github.com/AXRoux/tessera/issues";

const GLANCE: LegalGlance[] = [
  { title: "Sandbox only", text: "No real money moves through Tessera. It accepts Airwallex sandbox keys only, and the public demo runs on a simulator." },
  { title: "Not a bank", text: "Tessera holds no funds, issues no cards and gives no financial advice. Airwallex and your other providers act under their own terms." },
  { title: "You hold the keys", text: "You connect your own sandbox and model keys, you stay responsible for those accounts, and you can remove them at any time." },
  { title: "Agents propose, people sign", text: "The agent works through fourteen typed tools; policy in code decides, and risky actions wait for your written signature." },
  { title: "Use it fairly", text: "No production credentials, no keys you do not own, no attacks on the shared service. Guardrail tests inside your own workspace are welcome." },
  { title: "Provided as is", text: "A hackathon build: it may change, pause or reset. Liability is limited to the extent the law allows." },
];

const SECTIONS: LegalSection[] = [
  {
    heading: "About these terms",
    summary: "By creating an account or using the hosted service, you agree to these terms.",
    body: (
      <>
        <p>
          These Terms of Service (the <strong>Terms</strong>) govern your access to and use of Tessera, the hosted control layer
          for AI agents that work supplier payouts, operated by Vance Poitier and NULL* Team (<strong>we</strong>,{" "}
          <strong>us</strong>). They cover Tessera Live (the multi-tenant site where you sign in with your own keys), the public
          demo, and any related pages (together, the <strong>Service</strong>).
        </p>
        <p>
          You accept these Terms when you tick the box on the sign-up card or otherwise use the Service. If you use the Service
          on behalf of an organisation, you confirm that you are authorised to accept these Terms for it. If you do not agree,
          do not use the Service. Our <a href="/privacy">Privacy Policy</a> explains how we handle personal data and forms part
          of these Terms.
        </p>
      </>
    ),
  },
  {
    heading: "Eligibility and accounts",
    summary: "You must be an adult, give accurate details, keep your password safe, and use one account per person.",
    body: (
      <>
        <ul>
          <li>You must be at least 18 years old and able to enter into a binding agreement.</li>
          <li>Each account is for one named person. Provide accurate information and keep it current.</li>
          <li>
            Keep your password confidential. You are responsible for activity under your account; tell us promptly if you
            believe it has been compromised.
          </li>
          <li>We may limit sign-ups (for example, by rate) so the shared deployment stays available to everyone.</li>
        </ul>
      </>
    ),
  },
  {
    heading: "What Tessera is, and is not",
    summary: "A sandbox-only control layer between AI agents and an Airwallex treasury. It never moves real money.",
    body: (
      <>
        <p>
          Tessera lets an AI agent read supplier messages, assess failed or delayed payouts, draft replies and propose payments,
          while policy written in code decides what is allowed, an authorized individual signs anything risky, and every step is recorded
          in a tamper-evident, hash-chained ledger.
        </p>
        <LegalCallout title="Sandbox only">
          Tessera Live accepts Airwallex <strong>sandbox</strong> credentials only, and the public demo and the offline rehearsal
          run on a simulator. Balances, transfers, conversions and Visa cards shown in the Service are test objects. No real
          funds are held, moved or settled.
        </LegalCallout>
        <p>
          Tessera is not a bank, payment institution, money transmitter, card issuer or financial adviser. It does not hold
          funds, does not provide payment or card services itself, and nothing in the Service is financial, legal, tax or
          accounting advice. Payment, foreign-exchange and card functionality belongs to Airwallex and is governed by its own
          terms.
        </p>
      </>
    ),
  },
  {
    heading: "Your credentials and third-party accounts",
    summary: "You may only connect keys you are entitled to use; you stay responsible for those accounts and their costs.",
    body: (
      <>
        <p>
          To use Tessera Live you may connect an Airwallex sandbox Client ID and API key and, optionally, an API key for a model
          provider (Anthropic or an OpenAI-compatible endpoint). By connecting a credential you confirm that:
        </p>
        <ul>
          <li>you are authorised to use it, and to let the Service act with it on your behalf;</li>
          <li>its use complies with the terms of the provider that issued it; and</li>
          <li>you are responsible for any usage, charges or limits on that account, including model usage from agent runs you start.</li>
        </ul>
        <p>
          We store credentials encrypted and show only their last four characters (see the <a href="/privacy">Privacy Policy</a>
          ). You can replace or remove them from the workspace page at any time. Removing them does not affect your accounts with
          those providers.
        </p>
      </>
    ),
  },
  {
    heading: "AI agents and automated actions",
    summary: "Agent output can be wrong. Policy limits what it can do, and you remain responsible for what you sign.",
    body: (
      <>
        <p>
          The agent can act only through a fixed set of typed tools, and only where the policy allows. It cannot create a
          transfer on its own, sign an approval, change an amount or a beneficiary, sign a Visa card, or send mail. Actions above
          the automatic limits, and every card, wait for an authorized individual&rsquo;s written signature.
        </p>
        <ul>
          <li>
            AI-generated content, including assessments, extracted evidence and drafted replies, may be inaccurate or
            incomplete. Review it before you rely on it.
          </li>
          <li>Approvals and card signatures are recorded under your name. You are responsible for the actions you approve.</li>
          <li>Drafted replies are prepared for you to send yourself; Tessera never sends them.</li>
        </ul>
      </>
    ),
  },
  {
    heading: "Acceptable use",
    summary: "Use the Service for its purpose, on accounts you own, without harming it or other people.",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>connect production (live-money) credentials, or credentials you are not entitled to use;</li>
          <li>attempt to access another person&rsquo;s workspace, account, keys or data;</li>
          <li>probe, scan, overload or disrupt the shared deployment, or circumvent its rate limits or security controls;</li>
          <li>use the Service for anything unlawful, fraudulent or deceptive, or to impersonate any person or organisation;</li>
          <li>upload malware, or content you have no right to share, including other people&rsquo;s personal data beyond what a test requires; or</li>
          <li>use the Service to build a competing hosted offering by scraping or automated extraction.</li>
        </ul>
        <LegalCallout title="Guardrail testing is allowed">
          The built-in <strong>Test the guardrails</strong> feature, and adversarial testing of the agent inside your own
          workspace, are permitted and encouraged. Testing that targets the infrastructure or other users is not. Report
          security issues privately (see <strong>Contact</strong>) rather than publishing or exploiting them.
        </LegalCallout>
      </>
    ),
  },
  {
    heading: "Your content and data",
    summary: "What you put in remains yours; we use it only to run your workspace.",
    body: (
      <>
        <p>
          You keep all rights in the content you submit, including invoices, supplier messages, notes and approvals (
          <strong>Your Content</strong>). You grant us a limited, non-exclusive licence to host, process and display Your
          Content solely to operate the Service for you, as described in the <a href="/privacy">Privacy Policy</a>.
        </p>
        <p>
          Use test data where you can. If Your Content includes personal data about other people (for example, a supplier
          contact in a pasted email), you are responsible for having the right to share it.
        </p>
        <p>
          The ledger is append-only by design: individual events are not edited or removed, so the history stays verifiable.
          Deleting a workspace removes its ledger as a whole.
        </p>
      </>
    ),
  },
  {
    heading: "Open source and intellectual property",
    summary: "The code is MIT-licensed; these Terms cover the hosted Service, not your rights under that licence.",
    body: (
      <>
        <p>
          Tessera&rsquo;s source code is published at{" "}
          <a href="https://github.com/AXRoux/tessera" target="_blank" rel="noopener noreferrer">
            github.com/AXRoux/tessera
          </a>{" "}
          under the MIT License, which governs your use of the code. These Terms govern the hosted Service.
        </p>
        <p>
          The Tessera name and visual identity remain ours. Airwallex, Visa, Anthropic, OpenAI and other names shown in the
          Service are trademarks of their respective owners and are used only to identify compatible services; no endorsement
          is implied. If you send us feedback, we may use it without obligation to you.
        </p>
      </>
    ),
  },
  {
    heading: "Third-party services",
    summary: "Airwallex, Visa, your model provider and our host have their own terms; we are not responsible for them.",
    body: (
      <>
        <LegalTable
          head={["Service", "Role", "Governed by"]}
          rows={[
            ["Airwallex", "Sandbox payouts, FX, balances and Visa card issuing, with your keys", "Airwallex terms for your account"],
            ["Visa Trusted Agent Protocol", "The signature scheme the agent uses at checkout", "Visa's specifications"],
            ["Model provider", "Runs the agent and the reader when you connect a key", "Your agreement with that provider"],
            ["Amazon Web Services", "Hosts the Service", "Our agreement with AWS"],
          ]}
        />
        <p>
          We do not control these services and are not responsible for their availability, accuracy or conduct. Their failure
          may affect the Service.
        </p>
      </>
    ),
  },
  {
    heading: "Availability, changes and support",
    summary: "A hackathon project: best effort, no uptime guarantee, and some environments reset by design.",
    body: (
      <>
        <p>
          The Service is provided on a best-effort basis without any service-level commitment. We may change, suspend or
          discontinue any part of it at any time, including for maintenance or security. Where practical, we will give notice
          of changes that materially affect you.
        </p>
        <ul>
          <li>The offline rehearsal keeps its data in memory and starts fresh after a period of inactivity or a restart.</li>
          <li>The public demo is shared by everyone who visits it and resets itself after inactivity. Do not enter personal data there.</li>
          <li>Support is offered through the repository&rsquo;s issue tracker, without guaranteed response times.</li>
        </ul>
      </>
    ),
  },
  {
    heading: "Suspension and termination",
    summary: "You can leave at any time; we may suspend accounts that break these Terms or put the Service at risk.",
    body: (
      <>
        <p>
          You may stop using the Service and ask us to delete your workspace at any time (see <strong>Contact</strong>). We
          may suspend or terminate your access, with or without notice, if you breach these Terms, if your use creates a
          security or legal risk, or if we discontinue the Service.
        </p>
        <p>
          On termination your right to use the Service ends and we delete your workspace as described in the Privacy Policy.
          Sections that by their nature should survive (including intellectual property, disclaimers, limitation of liability
          and indemnity) survive termination.
        </p>
      </>
    ),
  },
  {
    heading: "Disclaimers",
    summary: "The Service comes as it is, without warranties.",
    body: (
      <p>
        To the fullest extent permitted by law, the Service is provided <strong>&ldquo;as is&rdquo; and &ldquo;as
        available&rdquo;</strong>, without warranties of any kind, whether express, implied or statutory, including warranties
        of merchantability, fitness for a particular purpose, title, non-infringement, accuracy and uninterrupted or
        error-free operation. We do not warrant that AI output, assessments, reconciliations or certificates are complete or
        correct.
      </p>
    ),
  },
  {
    heading: "Limitation of liability",
    summary: "Our liability is capped, and we are not liable for indirect losses, to the extent the law allows.",
    body: (
      <>
        <p>
          To the fullest extent permitted by law, we will not be liable for any indirect, incidental, special, consequential,
          exemplary or punitive damages, or for any loss of profits, revenue, data, goodwill or business opportunity, arising
          out of or relating to the Service.
        </p>
        <p>
          Our total liability for all claims relating to the Service is limited to <strong>USD 50</strong>. Because the
          Service is free and sandbox-only, no real funds are at risk through it.
        </p>
        <p>
          Nothing in these Terms limits liability that cannot be limited by law, such as liability for fraud or for death or
          personal injury caused by negligence, or rights you have as a consumer that cannot be waived.
        </p>
      </>
    ),
  },
  {
    heading: "Indemnity",
    summary: "If your misuse causes a claim against us, you cover it.",
    body: (
      <p>
        To the extent permitted by law, you will indemnify and hold us harmless from claims, losses and costs (including
        reasonable legal fees) arising from your breach of these Terms, your misuse of the Service, or your use of credentials
        or content you were not entitled to use.
      </p>
    ),
  },
  {
    heading: "Changes to these Terms",
    summary: "When the Terms change, the date and version above change, and material changes are announced.",
    body: (
      <p>
        We may update these Terms from time to time. The effective date and version at the top of this page show the current
        version. For material changes we will give reasonable notice in the Service before they take effect. Continuing to use
        the Service after the effective date means you accept the updated Terms; if you do not, stop using the Service and ask
        us to delete your workspace.
      </p>
    ),
  },
  {
    heading: "Governing law and disputes",
    summary: "Talk to us first; mandatory local consumer protections always still apply.",
    body: (
      <>
        <p>
          These Terms are governed by the laws of the jurisdiction in which the operator is established, without regard to its
          conflict-of-laws rules. If you are a consumer, you keep the protection of the mandatory laws of the country where you
          live.
        </p>
        <p>
          Before starting any formal proceedings, please contact us so we can try to resolve the matter informally. Both sides
          agree to try in good faith for at least 30 days.
        </p>
      </>
    ),
  },
  {
    heading: "General",
    summary: "The usual terms that make the rest work.",
    body: (
      <ul>
        <li>
          <strong>Entire agreement.</strong> These Terms and the Privacy Policy are the whole agreement between you and us about
          the Service.
        </li>
        <li>
          <strong>Severability.</strong> If any provision is found unenforceable, the rest remains in effect.
        </li>
        <li>
          <strong>No waiver.</strong> Not enforcing a provision is not a waiver of it.
        </li>
        <li>
          <strong>Assignment.</strong> You may not transfer these Terms without our consent; we may transfer them to a successor
          operator of the Service.
        </li>
        <li>
          <strong>Language.</strong> These Terms are written in English, and the English version governs.
        </li>
      </ul>
    ),
  },
  {
    heading: "Contact",
    summary: "Questions, bug reports and deletion requests go through the repository; we reply to your account email.",
    body: (
      <>
        <p>
          Open an issue at{" "}
          <a href={ISSUES} target="_blank" rel="noopener noreferrer">
            github.com/AXRoux/tessera/issues
          </a>
          . For anything about your account, such as deletion, say so in the issue <strong>without posting personal
          details</strong>; we will verify the request and reply to the email address on your account.
        </p>
        <p>To report a security vulnerability, do not publish the details: open an issue asking for a private channel, and we will arrange one.</p>
      </>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalShell
      label="Terms"
      title="Terms of Service"
      standfirst="The agreement for using Tessera: what the Service is, what sandbox-only means, what you and we each owe, and how it ends. Written to be read, not skimmed past."
      meta={{ effective: "16 November 2026", version: "2.0", appliesTo: "Tessera Live and the public demo" }}
      glance={GLANCE}
      sections={SECTIONS}
      sibling={{ href: "/privacy", label: "Privacy" }}
    />
  );
}
