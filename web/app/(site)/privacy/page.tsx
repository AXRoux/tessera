import type { Metadata } from "next";
import { LegalCallout, LegalShell, LegalTable, type LegalGlance, type LegalSection } from "@/components/site/legal";

export const metadata: Metadata = {
  title: "Privacy Policy · Tessera",
  description:
    "What personal data Tessera collects, why, where it goes, how long it is kept, how it is protected, and how to exercise your rights. No analytics, no advertising, no sale of data.",
};

const ISSUES = "https://github.com/AXRoux/tessera/issues";

const GLANCE: LegalGlance[] = [
  { title: "A small, fixed set of data", text: "Your account, your encrypted keys and your workspace ledger. Nothing else is collected about you." },
  { title: "No tracking", text: "No analytics, no advertising, no tracking pixels and no third-party cookies. Two first-party cookies, both functional." },
  { title: "Never sold", text: "We do not sell or share personal data for advertising, and we do not use your data to train AI models." },
  { title: "Keys sealed", text: "Credentials are encrypted with AES-256-GCM under a key derived per workspace, and only their last four characters are ever shown." },
  { title: "You choose what leaves", text: "Data goes to Airwallex and to a model provider only when you connect them. The offline rehearsal calls nothing." },
  { title: "Your rights", text: "Access, correct, export or delete your data. Deleting a workspace removes the account, keys and ledger together." },
];

const SECTIONS: LegalSection[] = [
  {
    heading: "Who we are and what this covers",
    summary: "This policy covers the hosted Tessera Service; we are responsible for the data it holds.",
    body: (
      <>
        <p>
          Tessera is operated by Vance Poitier and NULL* Team (<strong>we</strong>, <strong>us</strong>), who act as the
          controller of the personal data described here. This policy covers Tessera Live (the multi-tenant site where you sign
          in), the public demo and these web pages (the <strong>Service</strong>).
        </p>
        <p>
          It does not cover services you connect yourself, such as Airwallex or your model provider, which handle data under
          their own policies, or copies of the open-source code that other people run on their own infrastructure.
        </p>
      </>
    ),
  },
  {
    heading: "Information we collect",
    summary: "What you give us when you sign up and work, a few technical records for security, and two preference cookies.",
    body: (
      <>
        <LegalTable
          head={["Category", "What it includes", "Source"]}
          rows={[
            ["Account", "Name, email address, a salted one-way hash of your password, and the time you accepted the Terms", "You, at sign-up"],
            ["Sessions", "A session token, its expiry, and the IP address and browser user agent the session was created from", "Your browser, at sign-in"],
            ["Credentials", "Airwallex sandbox Client ID and API key; model provider, model, endpoint and API key, if you connect one", "You, on the workspace page"],
            [
              "Workspace ledger",
              "Invoices, transfer attempts, conversions, Visa card records (last four digits only), approvals and notes under your name, supplier messages you add, agent tool calls and closure certificates",
              "You, the agent working for you, and Airwallex",
            ],
            ["Security records", "Client IP addresses held briefly in memory for rate limiting, and server error logs", "Your requests"],
            ["Preferences", "A theme cookie, and browser storage for walkthrough progress and a one-time animation flag", "Your browser"],
          ]}
        />
        <h3>What we do not collect</h3>
        <ul>
          <li>No analytics, advertising identifiers, tracking pixels, fingerprinting or third-party cookies.</li>
          <li>
            No full card numbers or card security codes. Cards are issued by Airwallex; Tessera only ever stores a card&rsquo;s last
            four digits and Airwallex&rsquo;s card id.
          </li>
          <li>No payment details from you: the Service is free.</li>
        </ul>
      </>
    ),
  },
  {
    heading: "How we use it",
    summary: "To run your workspace, keep it secure, and nothing else.",
    body: (
      <>
        <ul>
          <li>to create and authenticate your account and keep you signed in;</li>
          <li>to run your workspace: call Airwallex and your model provider with your keys, assess incidents and keep the ledger;</li>
          <li>to keep the Service secure and available, including rate limiting and investigating abuse or errors;</li>
          <li>to record the terms you accepted and the approvals you sign, which is the purpose of the audit ledger; and</li>
          <li>to comply with legal obligations.</li>
        </ul>
        <LegalCallout title="What we never do">
          We do not sell personal data, share it for cross-context advertising, use it for profiling, or use your data to train
          AI models.
        </LegalCallout>
      </>
    ),
  },
  {
    heading: "Legal bases",
    summary: "For visitors in the EEA, the UK and similar regimes, these are the grounds we rely on.",
    body: (
      <LegalTable
        head={["Purpose", "Legal basis"]}
        rows={[
          ["Providing your account and workspace", "Performance of a contract (these Terms)"],
          ["Security, rate limiting, debugging and preventing abuse", "Our legitimate interest in a safe, working Service"],
          ["Sending data to the model provider and Airwallex you connect", "Performance of a contract, at your direction"],
          ["Recording terms acceptance and signed approvals", "Legitimate interest, and compliance with legal obligations"],
          ["Preference cookies and browser storage", "Strictly necessary or functional; no consent-based tracking is used"],
        ]}
      />
    ),
  },
  {
    heading: "How AI processing works",
    summary: "Your model provider sees what the agent needs to do its work, never your credentials.",
    body: (
      <>
        <p>
          If you connect a model provider and start an agent run, the provider receives the agent&rsquo;s instructions and the
          results of its tool calls: ledger facts such as references, amounts, statuses and policy decisions. If you have the
          reader extract evidence, it also receives the text of the supplier message being read.
        </p>
        <ul>
          <li>The model never receives your passwords, your Airwallex or model credentials, approval secrets or database access.</li>
          <li>Supplier message text is quarantined: the agent itself sees only the structured facts the reader extracts.</li>
          <li>Your provider processes this data under its own terms and policies, which you accepted when you obtained its key.</li>
          <li>The offline rehearsal and its built-in agent send nothing to any model provider.</li>
        </ul>
      </>
    ),
  },
  {
    heading: "Sharing and service providers",
    summary: "Only the providers needed to run the Service, and only the services you connect.",
    body: (
      <>
        <LegalTable
          head={["Recipient", "Purpose", "Location"]}
          rows={[
            ["Amazon Web Services", "Hosting: compute, encrypted storage, daily backups and secret storage", "United States (us-east-2, Ohio)"],
            ["Airwallex", "Sandbox API calls made with your keys, when you connect them", "Per Airwallex"],
            ["Your model provider", "Agent and reader processing, when you connect a key", "Per your provider"],
            ["GitHub", "Only what you choose to post when you contact us through an issue (public)", "United States"],
          ]}
        />
        <p>
          We may also disclose information if required by law or to protect the rights, safety and security of users and the
          Service. If the Service were transferred to another operator, this policy would continue to apply to the data
          transferred, and we would tell you first.
        </p>
      </>
    ),
  },
  {
    heading: "International transfers",
    summary: "The Service runs in the United States.",
    body: (
      <p>
        Data is stored and processed in the United States. If you use the Service from elsewhere, your data is transferred
        there. Where the law requires it, we rely on appropriate safeguards for such transfers, and the protections in this
        policy apply wherever your data is processed.
      </p>
    ),
  },
  {
    heading: "How long we keep it",
    summary: "As long as your workspace exists, with short, fixed windows for sessions, backups and logs.",
    body: (
      <>
        <LegalTable
          head={["Data", "Kept for"]}
          rows={[
            ["Account and workspace ledger", "Until you ask us to delete your workspace"],
            ["Connected credentials", "Until you remove them, or the workspace is deleted"],
            ["Sessions", "Up to 7 days, or until you sign out"],
            ["Rate-limit records", "In memory only, for minutes"],
            ["Server logs", "Rotated automatically; a few tens of megabytes per service at most"],
            ["Backups", "Daily encrypted disk snapshots, each kept for 7 days"],
            ["Offline rehearsal", "In memory only; discarded after inactivity or a restart"],
            ["Public demo", "In memory, shared by all visitors; reset after 15 minutes of inactivity"],
          ]}
        />
        <p>
          The ledger is append-only and hash-chained so its history can be verified; individual events are not edited or
          removed. A deletion request therefore deletes the workspace as a whole. Deleted data may remain in backups until those
          snapshots expire, at most 7 days later.
        </p>
      </>
    ),
  },
  {
    heading: "How we protect it",
    summary: "Encryption in transit and at rest, sealed credentials, and a minimal attack surface.",
    body: (
      <ul>
        <li>All traffic is served over HTTPS with HSTS; plain HTTP is redirected.</li>
        <li>Passwords are stored only as salted one-way hashes; session cookies are httpOnly and Secure.</li>
        <li>
          Credentials are encrypted with AES-256-GCM under a key derived for each workspace, bound to your account, and shown only
          as their last four characters. No route returns a stored key.
        </li>
        <li>The server&rsquo;s own secrets live in a managed secret store; its disk is encrypted and its data directory is restricted.</li>
        <li>The host accepts web traffic only (HTTP is redirected to HTTPS); there is no SSH access, and sign-in and sign-up are rate limited.</li>
        <li>
          The public demo runs with no outbound network access and holds no secrets. Every ledger is hash-chained, so tampering
          with its history is detectable.
        </li>
      </ul>
    ),
  },
  {
    heading: "Your rights and choices",
    summary: "Ask to see, correct, export or delete your data; we answer within 30 days.",
    body: (
      <>
        <p>Depending on where you live, you may have the right to:</p>
        <ul>
          <li>access the personal data we hold about you, and receive a copy in a portable format;</li>
          <li>correct inaccurate data, or have your data deleted;</li>
          <li>object to or restrict certain processing; and</li>
          <li>lodge a complaint with your local data protection authority.</li>
        </ul>
        <p>
          You can change or remove your connected keys yourself on the workspace page, and sign out at any time. For anything
          else, contact us as described below. We will verify the request against your account email and respond within 30
          days. Residents of California and similar states: we do not sell or share personal information, and we will not
          treat you differently for exercising your rights.
        </p>
      </>
    ),
  },
  {
    heading: "Cookies and browser storage",
    summary: "Two first-party cookies and a little browser storage, all functional.",
    body: (
      <LegalTable
        head={["Name", "Type", "Purpose", "Duration"]}
        rows={[
          ["Session cookie", "First-party, httpOnly, Secure", "Keeps you signed in", "Up to 7 days"],
          [<code key="t">tessera-theme</code>, "First-party cookie", "Remembers light or dark mode", "Until cleared"],
          ["Walkthrough progress", "Local storage", "Remembers which getting-started steps you have hidden", "Until cleared"],
          ["Animation flag", "Session storage", "Plays the landing page animation once per visit", "Until the tab closes"],
        ]}
      />
    ),
  },
  {
    heading: "Children",
    summary: "The Service is for adults only.",
    body: (
      <p>
        The Service is not directed to anyone under 18, and we do not knowingly collect their personal data. If you believe a
        minor has created an account, contact us and we will delete it.
      </p>
    ),
  },
  {
    heading: "The public demo",
    summary: "Anything typed into the public demo is visible to other visitors. Use test data only.",
    body: (
      <LegalCallout title="Shared by everyone" tone="warn">
        The public demo has no accounts: every visitor works on the same in-memory ledger until it resets. Do not enter
        personal data, real supplier details or credentials there.
      </LegalCallout>
    ),
  },
  {
    heading: "Changes to this policy",
    summary: "When this policy changes, the date and version above change, and material changes are announced.",
    body: (
      <p>
        We may update this policy as the Service changes. The effective date and version at the top of this page identify the
        current version, and we will give notice in the Service before any material change takes effect.
      </p>
    ),
  },
  {
    heading: "Contact",
    summary: "Privacy questions and requests go through the repository; we reply to your account email.",
    body: (
      <>
        <p>
          Open an issue at{" "}
          <a href={ISSUES} target="_blank" rel="noopener noreferrer">
            github.com/AXRoux/tessera/issues
          </a>{" "}
          titled <strong>Privacy request</strong>. Issues are public, so <strong>do not include personal details</strong>; say
          what you would like done and we will verify the request and continue privately at the email address on your account.
        </p>
      </>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalShell
      label="Privacy"
      title="Privacy Policy"
      standfirst="What Tessera collects, why each piece exists, where it goes, how long it stays and how it is protected. A short list, because the Service is built to need very little."
      meta={{ effective: "16 November 2026", version: "2.0", appliesTo: "Tessera Live and the public demo" }}
      glance={GLANCE}
      sections={SECTIONS}
      sibling={{ href: "/terms", label: "Terms" }}
    />
  );
}
