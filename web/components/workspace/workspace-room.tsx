"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { WorkspaceResponseSchema, type WorkspaceResponse } from "../../../src/server/wire";
import { api, ApiProblem } from "@/lib/client-api";
import { authClient } from "@/lib/auth-client";
import { AgentMark } from "../kit/agent-mark";
import { Btn, LinkBtn } from "../kit/metal";
import { Chip, Kicker, RingSquare, Tile, Toggle, Tray, TrayHead } from "../kit/widgets";
import { Icon } from "../landing/icons";
import { Workspace } from "../shell";

const FIELD = "well h-11 w-full rounded-[14px]! px-3.5 text-[13.5px] text-fg outline-none placeholder:text-fg/35 transition-shadow focus-visible:ring-2 focus-visible:ring-accent/45";

const when = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12px] font-medium text-fg/70">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-[11.5px] leading-snug text-fg/45">{hint}</p> : null}
    </div>
  );
}

/** A secret field: hidden by default, never prefilled, never read back from the server. */
function Secret({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (next: string) => void; placeholder: string }) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        className={`${FIELD} readout pr-11`}
      />
      <button
        type="button"
        onClick={() => setReveal((was) => !was)}
        aria-label={reveal ? "Hide the key" : "Show the key"}
        className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-fg/45 hover:text-fg"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-[17px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
          <circle cx="12" cy="12" r="3" />
          {reveal ? null : <path d="m3 3 18 18" />}
        </svg>
      </button>
    </div>
  );
}

function Problem({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="well flex items-start gap-2.5 rounded-[14px]! px-3.5 py-2.5 text-[12.5px] leading-snug text-bad">
      <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-bad" />
      {message}
    </p>
  );
}

/** A connected key, shown the only way it ever is after saving: by its last four characters. */
function KeyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-fg/[0.06] py-2 first:border-t-0">
      <span className="text-[12px] text-fg/55">{label}</span>
      <span className="readout text-[12.5px] font-medium">{value}</span>
    </div>
  );
}

const sentence = (error: unknown): string =>
  error instanceof ApiProblem ? error.problem.message : "That did not go through. Check your connection and try again.";

/**
 * The person's workspace: who they are, and the two keys that turn rehearsal into the real thing. Airwallex sandbox keys
 * make it live, with a ledger of its own; a model key makes the agent theirs. Each is checked with its provider before
 * it is saved, sealed at rest, and from then on only ever shown by its last four characters.
 */
export function WorkspaceRoom({ initial, welcome }: { initial: WorkspaceResponse; welcome: boolean }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const { user, workspace } = state;
  const live = workspace.mode === "live";

  const save = async (path: string, body: unknown): Promise<string | null> => {
    try {
      setState(await api(path, WorkspaceResponseSchema, { method: "POST", body }));
      router.refresh();
      return null;
    } catch (error) {
      return sentence(error);
    }
  };

  return (
    <Workspace>
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <Kicker>Workspace</Kicker>
          <h1 className="mt-2 text-[clamp(22px,1.9vw,30px)] font-semibold leading-[1.1] tracking-[-0.04em]">
            {welcome ? `Welcome, ${user.name.split(" ")[0]}. Your workspace is ready.` : live ? "Live on your Airwallex sandbox." : "Rehearsing, offline."}
          </h1>
          <p className="mt-1.5 max-w-[680px] text-[13px] leading-snug text-fg/55">
            {live
              ? "Payouts go through your own sandbox account and are recorded in a ledger only you can see."
              : "Everything works here already, against a simulated Airwallex. Connect your sandbox keys to send real sandbox payouts, and a model key to make the agent yours."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={live ? "accent" : "neutral"} pulse={live}>
            {live ? "Live sandbox" : "Offline rehearsal"}
          </Chip>
          <LinkBtn href="/dashboard" icon={<Icon name="dashboard" className="size-4" />}>
            Open the control room
          </LinkBtn>
        </div>
      </div>

      <div className="grid min-h-0 gap-4 xl:flex-1 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Account user={user} live={live} model={workspace.model !== null} />
        <AirwallexCard workspace={workspace} save={save} />
        <ModelCard workspace={workspace} save={save} />
      </div>
    </Workspace>
  );
}

function Account({ user, live, model }: { user: WorkspaceResponse["user"]; live: boolean; model: boolean }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const steps = [
    { done: true, label: "Account created", note: "Signed in with your email and password" },
    { done: live, label: "Airwallex sandbox connected", note: "Real sandbox payouts, your own ledger" },
    { done: model, label: "Your model connected", note: "The agent runs on your key" },
  ];
  const progress = steps.filter((s) => s.done).length / steps.length;
  return (
    <Tray label="You" className="min-h-[520px] gap-3 overflow-hidden p-3 xl:min-h-0">
      <TrayHead n={1} className="px-2 pt-1" title="You" note="The name every approval is signed with" />
      <Tile invert className="flex items-center gap-4 rounded-[24px]! p-4">
        <span className="tile flex size-14 shrink-0 items-center justify-center rounded-[18px]! text-[17px] font-semibold">{(user.name || user.email).slice(0, 2).toUpperCase()}</span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold">{user.name}</span>
          <span className="readout block truncate text-[12px] text-fg/55">{user.email}</span>
        </span>
      </Tile>

      <Tile className="rounded-[22px]! px-4 py-3.5">
        <div className="flex items-center justify-between">
          <Kicker>Setup</Kicker>
          <span className="readout text-[11.5px] text-fg/50">{Math.round(progress * 3)}/3</span>
        </div>
        <div className="well mt-2.5 h-2 overflow-hidden rounded-full!" role="img" aria-label={`Setup ${Math.round(progress * 100)}% done`}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${progress * 100}%` }} />
        </div>
        <ol className="mt-3 space-y-2.5">
          {steps.map((step) => (
            <li key={step.label} className="flex items-start gap-3">
              <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${step.done ? "bg-accent text-white" : "well text-fg/35"}`}>
                {step.done ? <Icon name="check" className="size-4" /> : <span className="size-1.5 rounded-full bg-current" />}
              </span>
              <span className="min-w-0">
                <span className={`block text-[13px] font-medium ${step.done ? "" : "text-fg/65"}`}>{step.label}</span>
                <span className="block text-[11.5px] text-fg/45">{step.note}</span>
              </span>
            </li>
          ))}
        </ol>
      </Tile>

      <Tile className="thin-scroll min-h-0 flex-1 overflow-y-auto rounded-[22px]! px-4 py-3.5">
        <Kicker>How your keys are kept</Kicker>
        <ul className="mt-3 space-y-3 text-[12.5px] leading-snug">
          {[
            { icon: "lock" as const, title: "Sealed at rest", text: "AES-256-GCM, with a key derived for your workspace alone." },
            { icon: "shield" as const, title: "Never sent back", text: "Not to this page, not to any page. You will only ever see the last four characters." },
            { icon: "wallet" as const, title: "Sandbox only", text: "This host refuses anything but the Airwallex sandbox. Real money cannot move." },
            { icon: "hand" as const, title: "Yours to remove", text: "Disconnect at any time; the key is deleted, not hidden." },
          ].map((item) => (
            <li key={item.title} className="flex gap-3">
              <Icon name={item.icon} className="mt-0.5 size-4 shrink-0 text-accent" />
              <span>
                <span className="block font-medium">{item.title}</span>
                <span className="block text-fg/55">{item.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </Tile>

      <Btn
        tone="secondary"
        block
        busy={leaving}
        onClick={async () => {
          setLeaving(true);
          await authClient.signOut().catch(() => undefined);
          router.push("/sign-in");
          router.refresh();
        }}
      >
        Sign out
      </Btn>
    </Tray>
  );
}

function AirwallexCard({ workspace, save }: { workspace: WorkspaceResponse["workspace"]; save: (path: string, body: unknown) => Promise<string | null> }) {
  const clientIdId = useId();
  const keyId = useId();
  const [clientId, setClientId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"connect" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const connected = workspace.airwallex;

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy("connect");
    setError(null);
    const failed = await save("workspace/airwallex", { clientId: clientId.trim(), apiKey: apiKey.trim() });
    setBusy(null);
    if (failed) setError(failed);
    else {
      setClientId("");
      setApiKey("");
      setReplacing(false);
    }
  }

  return (
    <Tray label="Airwallex sandbox" className="min-h-[520px] gap-3 p-3 xl:min-h-0">
      <TrayHead n={2} className="px-2 pt-1" title="Airwallex sandbox" note="Turns rehearsal into real sandbox payouts" right={<Chip tone={connected ? "accent" : "neutral"}>{connected ? "Connected" : "Not connected"}</Chip>} />

      <Tile className="flex items-center gap-4 rounded-[24px]! p-4">
        <RingSquare value={connected ? 1 : 0} tone="accent" size={72}>
          <Icon name="wallet" className="size-6" />
        </RingSquare>
        <div className="min-w-0 flex-1">
          {connected ? (
            <>
              <KeyLine label="Client ID" value={connected.clientIdHint} />
              <KeyLine label="API key" value={connected.keyHint} />
              <KeyLine label="Connected" value={when(connected.connectedAt)} />
            </>
          ) : (
            <p className="text-[13px] leading-relaxed text-fg/65">
              Your workspace runs on a simulated Airwallex until you connect. Use <span className="font-medium text-fg">sandbox</span> keys: real money cannot move on this host.
            </p>
          )}
        </div>
      </Tile>

      {connected && !replacing ? (
        <Tile className="flex min-h-0 flex-1 flex-col gap-3 rounded-[24px]! p-4">
          <Kicker>Payouts go to</Kicker>
          <p className="readout truncate text-[13px]">spike-us-supplier · {connected.beneficiaryId.slice(0, 8)}…</p>
          <p className="text-[12px] leading-relaxed text-fg/55">
            A US test supplier in your sandbox, created for you when you connected. Every payout you send from the control room goes here, over LOCAL in USD.
          </p>
          <div className="mt-auto grid grid-cols-2 gap-2">
            <Btn tone="secondary" block onClick={() => setReplacing(true)}>
              Replace keys
            </Btn>
            <Btn
              tone="secondary"
              block
              busy={busy === "remove"}
              onClick={async () => {
                setBusy("remove");
                setError(await save("workspace/airwallex/remove", {}));
                setBusy(null);
              }}
            >
              Disconnect
            </Btn>
          </div>
          <Problem message={error} />
        </Tile>
      ) : (
        <form onSubmit={connect} className="tile flex min-h-0 flex-1 flex-col gap-3 rounded-[24px]! p-4">
          <Field id={clientIdId} label="Client ID">
            <input id={clientIdId} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} placeholder="From your sandbox account" className={`${FIELD} readout`} />
          </Field>
          <Field id={keyId} label="API key" hint="Airwallex sandbox: Settings › Developer › API keys. Tessera checks the keys with Airwallex before saving them.">
            <Secret id={keyId} value={apiKey} onChange={setApiKey} placeholder="Paste the API key" />
          </Field>
          <Problem message={error} />
          <div className="mt-auto flex gap-2">
            {replacing ? (
              <Btn tone="secondary" type="button" onClick={() => setReplacing(false)}>
                Cancel
              </Btn>
            ) : null}
            <Btn type="submit" block disabled={clientId.trim().length < 8 || apiKey.trim().length < 16} busy={busy === "connect"} icon={<Icon name="lock" className="size-4" />}>
              {busy === "connect" ? "Checking with Airwallex…" : "Connect and seal"}
            </Btn>
          </div>
        </form>
      )}
    </Tray>
  );
}

const DEFAULT_MODEL = { anthropic: "claude-sonnet-4-5", openai: "" } as const;

function ModelCard({ workspace, save }: { workspace: WorkspaceResponse["workspace"]; save: (path: string, body: unknown) => Promise<string | null> }) {
  const modelId = useId();
  const keyId = useId();
  const baseId = useId();
  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [model, setModel] = useState<string>(DEFAULT_MODEL.anthropic);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<"connect" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const connected = workspace.model;
  const ready = model.trim().length > 0 && apiKey.trim().length > 0 && (provider === "anthropic" || baseUrl.trim().startsWith("https://"));

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy("connect");
    setError(null);
    const body = provider === "anthropic" ? { provider, modelId: model.trim(), apiKey: apiKey.trim() } : { provider, modelId: model.trim(), apiKey: apiKey.trim(), baseUrl: baseUrl.trim() };
    const failed = await save("workspace/model", body);
    setBusy(null);
    if (failed) setError(failed);
    else {
      setApiKey("");
      setReplacing(false);
    }
  }

  return (
    <Tray label="Your model" className="min-h-[520px] gap-3 p-3 xl:min-h-0">
      <TrayHead n={3} className="px-2 pt-1" title="Your model" note="The agent runs on your key, agent-agnostic" right={<Chip tone={connected ? "accent" : "neutral"}>{connected ? "Connected" : "Scripted agent"}</Chip>} />

      <Tile className="flex items-center gap-4 rounded-[24px]! p-4">
        <RingSquare value={connected ? 1 : 0} tone="accent" size={72}>
          <AgentMark size={38} className="rounded-[10px]" />
        </RingSquare>
        <div className="min-w-0 flex-1">
          {connected ? (
            <>
              <KeyLine label="Provider" value={connected.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"} />
              <KeyLine label="Model" value={connected.modelId} />
              <KeyLine label="Key" value={connected.keyHint} />
            </>
          ) : (
            <p className="text-[13px] leading-relaxed text-fg/65">
              Until you bring a model, the agent is a deterministic script: same tools, same refusals, no reasoning. Any Anthropic model works, or any OpenAI-compatible endpoint.
            </p>
          )}
        </div>
      </Tile>

      {connected && !replacing ? (
        <Tile className="flex min-h-0 flex-1 flex-col gap-3 rounded-[24px]! p-4">
          <Kicker>What it can do</Kicker>
          <p className="text-[12.5px] leading-relaxed text-fg/60">
            Thirteen typed tools and no keys to the vault. It reads, assesses, waits, drafts and escalates; only the code can say yes to money, and anything uncertain comes back to you. Runs spend your key, and only when you press a button.
          </p>
          <div className="mt-auto grid grid-cols-2 gap-2">
            <Btn tone="secondary" block onClick={() => setReplacing(true)}>
              Change model
            </Btn>
            <Btn
              tone="secondary"
              block
              busy={busy === "remove"}
              onClick={async () => {
                setBusy("remove");
                setError(await save("workspace/model/remove", {}));
                setBusy(null);
              }}
            >
              Disconnect
            </Btn>
          </div>
          <Problem message={error} />
        </Tile>
      ) : (
        <form onSubmit={connect} className="tile flex min-h-0 flex-1 flex-col gap-3 rounded-[24px]! p-4">
          <Toggle
            label="Provider"
            value={provider}
            onChange={(next) => {
              setProvider(next);
              setModel(DEFAULT_MODEL[next]);
            }}
            className="w-fit"
            options={[
              { id: "anthropic", label: "Anthropic" },
              { id: "openai", label: "OpenAI-compatible" },
            ]}
          />
          {provider === "openai" ? (
            <Field id={baseId} label="Endpoint" hint="Any Chat Completions endpoint over https: OpenRouter, Together, your own gateway.">
              <input id={baseId} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="https://openrouter.ai/api/v1" className={`${FIELD} readout`} />
            </Field>
          ) : null}
          <Field id={modelId} label="Model">
            <input id={modelId} value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} placeholder={provider === "anthropic" ? "claude-sonnet-4-5" : "nousresearch/hermes-4-405b"} className={`${FIELD} readout`} />
          </Field>
          <Field id={keyId} label="API key" hint="Checked against the provider before it is saved. Runs spend this key only when you start one.">
            <Secret id={keyId} value={apiKey} onChange={setApiKey} placeholder={provider === "anthropic" ? "sk-ant-…" : "Paste the key"} />
          </Field>
          <Problem message={error} />
          <div className="mt-auto flex gap-2">
            {replacing ? (
              <Btn tone="secondary" type="button" onClick={() => setReplacing(false)}>
                Cancel
              </Btn>
            ) : null}
            <Btn type="submit" block disabled={!ready} busy={busy === "connect"} icon={<Icon name="lock" className="size-4" />}>
              {busy === "connect" ? "Checking the key…" : "Connect and seal"}
            </Btn>
          </div>
        </form>
      )}
    </Tray>
  );
}
