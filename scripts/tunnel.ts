/**
 * A public HTTPS URL for the webhook listener, for `bun run dev -- --tunnel`. Only the listener's port is exposed, never
 * the API or the console.
 *
 * Two providers, tried in order:
 *   cloudflared     a Cloudflare quick tunnel (https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
 *                   Needs outbound QUIC or TCP 7844 to Cloudflare's edge; some networks block both (seen 2026-11-06:
 *                   cloudflared printed a URL that never connected and answered 530).
 *   localhost.run   an SSH reverse tunnel (https://localhost.run/docs/), outbound TCP 22 only, no account, no install.
 *                   It forwards no client-address header (checked 2026-11-06), and may hand out a new hostname on the
 *                   same connection; the old one then answers "no tunnel".
 * TESSERA_TUNNEL_PROVIDER pins one. Both hand out a random hostname per run, so the caller re-points the subscription
 * every time a URL appears, and a provider only counts as working once a request through it reached the listener.
 * TESSERA_WEBHOOK_SOURCE_IPS reads Cloudflare's `cf-connecting-ip`, so with it set only cloudflared can deliver.
 */
import type { Subprocess } from "bun";

export const TUNNEL_PROVIDERS = ["cloudflared", "localhost.run"] as const;
export type TunnelProvider = (typeof TUNNEL_PROVIDERS)[number];

/**
 * The providers to try, in order. `has` says whether a binary is on PATH; `sourceAllowlist` is whether
 * TESSERA_WEBHOOK_SOURCE_IPS is set. Unknown pins, and pins that could never deliver, fail closed.
 */
export function tunnelProviders(pinned: string | undefined, has: (binary: string) => boolean, sourceAllowlist = false): TunnelProvider[] {
  const usable = (provider: TunnelProvider) => provider === "cloudflared" || !sourceAllowlist;
  if (pinned) {
    if (!(TUNNEL_PROVIDERS as readonly string[]).includes(pinned)) {
      throw new Error(`TESSERA_TUNNEL_PROVIDER must be one of ${TUNNEL_PROVIDERS.join(", ")} (got ${pinned})`);
    }
    const provider = pinned as TunnelProvider;
    if (!has(binaryFor(provider))) throw new Error(`TESSERA_TUNNEL_PROVIDER=${provider} needs ${binaryFor(provider)} on PATH`);
    if (!usable(provider)) throw new Error(`${provider} forwards no client address, so TESSERA_WEBHOOK_SOURCE_IPS would refuse every delivery; unset one of them`);
    return [provider];
  }
  return TUNNEL_PROVIDERS.filter((provider) => usable(provider) && has(binaryFor(provider)));
}

function binaryFor(provider: TunnelProvider): string {
  return provider === "cloudflared" ? "cloudflared" : "ssh";
}

export function tunnelCommand(provider: TunnelProvider, port: string): string[] {
  if (provider === "cloudflared") return ["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
  return [
    "ssh", "-T",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-R", `80:127.0.0.1:${port}`,
    "nokey@localhost.run",
  ];
}

/**
 * The public base URL a provider's log line announces, or null. cloudflared logs its hostname a few seconds after start
 * (not on its first line); localhost.run prints `<host> tunneled with tls termination, https://<host>` and prints a new
 * one if it hands out another hostname mid-run.
 */
export function tunnelUrlFrom(provider: TunnelProvider, line: string): string | null {
  const match = provider === "cloudflared"
    ? /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)
    : /tunneled with tls termination, (https:\/\/[a-z0-9.-]+)/.exec(line);
  return match ? (match[1] ?? match[0]) : null;
}

/** The listener answers 405 to a GET on its one route; nothing else between here and it does. */
export async function reachesListener(url: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.status === 405;
  } catch {
    return false;
  }
}

/** Polls `reachesListener` until it answers or `withinMs` passes. */
export async function waitForListener(url: string, withinMs: number, everyMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (await reachesListener(url)) return true;
    await Bun.sleep(everyMs);
  }
  return false;
}

/** One provider process. `urls` yields every base URL it announces; `exited` settles when the process ends. */
export class Tunnel {
  readonly exited: Promise<number | null>;
  private readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  private readonly waiters: Array<(url: string | null) => void> = [];
  private readonly announced: string[] = [];
  private done = false;

  constructor(readonly provider: TunnelProvider, port: string, private readonly log: (line: string) => void) {
    this.proc = Bun.spawn(tunnelCommand(provider, port), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    void this.read(this.proc.stdout);
    void this.read(this.proc.stderr);
    this.exited = this.proc.exited.then((code) => {
      this.done = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
      return code;
    });
  }

  /** The next URL announced after `seen` of them, or null if the process ends (or `withinMs` passes) first. */
  next(seen: number, withinMs?: number): Promise<string | null> {
    if (this.announced.length > seen) return Promise.resolve(this.announced[seen]!);
    if (this.done) return Promise.resolve(null);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const timer = withinMs === undefined ? undefined : setTimeout(() => resolve(null), withinMs);
    this.waiters.push((url) => {
      clearTimeout(timer);
      resolve(url);
    });
    return promise;
  }

  kill(): void {
    this.proc.kill("SIGTERM");
  }

  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) this.line(line);
    }
    if (pending) this.line(pending);
  }

  private line(raw: string): void {
    // localhost.run draws a QR code out of coloured spaces: nothing to read once the colour codes are gone.
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (line.trim()) this.log(line);
    const url = tunnelUrlFrom(this.provider, line);
    if (!url || this.announced.includes(url)) return;
    this.announced.push(url);
    for (const waiter of this.waiters.splice(0)) waiter(url);
  }
}
