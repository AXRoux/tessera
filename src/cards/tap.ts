/**
 * Visa's Trusted Agent Protocol (TAP), both sides of it: the agent signs, the merchant verifies.
 *
 * TAP is RFC 9421 HTTP Message Signatures with a fixed set of parameters (Visa TAP specification, "Agent Recognition
 * Signature"): the signature covers `@authority` and `@path`, and its parameters carry `created`, `expires` (at most
 * eight minutes later), `keyid`, `alg`, a `nonce` the merchant may never see twice, and a `tag` saying what the agent is
 * doing (`agent-browser-auth` to look, `agent-payer-auth` to pay). Objects in the body (the agentic payment container)
 * are signed with the same key and carry the same nonce, which links them to the request.
 *
 * Tessera's agent key is Ed25519, derived from the instance's approval secret so it is stable across restarts without
 * being stored, and published as a JWK at `/api/tap/keys` (TAP's "Public Keys Retrieval": GET /keys returns JWKs).
 */
import { createHash, createPrivateKey, createPublicKey, hkdfSync, sign, verify, type KeyObject } from "node:crypto";

export type TapTag = "agent-browser-auth" | "agent-payer-auth";
export const TAP_TAGS: readonly TapTag[] = ["agent-browser-auth", "agent-payer-auth"];
/** TAP: created and expires may be at most eight minutes apart, and a nonce is remembered for as long. */
export const TAP_WINDOW_SECONDS = 8 * 60;
/** Clock skew tolerated on `created` being in the past. */
const SKEW_SECONDS = 5;

export interface TapKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface TapJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  alg: "Ed25519";
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/** The raw 32-byte Ed25519 public key. */
function rawPublic(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url");
}

/** RFC 7638 JWK thumbprint, the key id agents and merchants agree on. */
function thumbprint(x: string): string {
  return base64url(createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest());
}

/** An Ed25519 key from a 32-byte seed (PKCS#8 wraps the seed after a fixed prefix). */
function keyFromSeed(seed: Buffer): TapKey {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return { kid: thumbprint(base64url(rawPublic(publicKey))), privateKey, publicKey };
}

/** The agent's signing key, derived from a secret the instance already holds (its approval secret). */
export function agentKeyFrom(secret: string, label = "tessera-tap-agent"): TapKey {
  const seed = Buffer.from(hkdfSync("sha256", secret, "tessera", label, 32));
  return keyFromSeed(seed);
}

export function publicJwk(key: Pick<TapKey, "kid" | "publicKey">): TapJwk {
  return { kty: "OKP", crv: "Ed25519", x: base64url(rawPublic(key.publicKey)), kid: key.kid, use: "sig", alg: "Ed25519" };
}

export function keyFromJwk(jwk: { x: string }): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
}

/** The signature base (RFC 9421 section 2.5) over `@authority` and `@path`, ending with `@signature-params`. */
function signatureBase(authority: string, path: string, params: string): string {
  return `"@authority": ${authority}\n"@path": ${path}\n"@signature-params": ${params}`;
}

export interface SignedHeaders {
  "Signature-Input": string;
  Signature: string;
}

/** Signs a request the way a TAP agent does. `now` is seconds since the epoch. */
export function signRequest(input: {
  key: TapKey;
  authority: string;
  path: string;
  tag: TapTag;
  nonce: string;
  now?: number;
  /** Seconds the signature stays valid; at most eight minutes. */
  ttl?: number;
}): SignedHeaders {
  const created = input.now ?? Math.floor(Date.now() / 1000);
  const expires = created + Math.min(input.ttl ?? 300, TAP_WINDOW_SECONDS);
  const params = `("@authority" "@path");created=${created};expires=${expires};keyid="${input.key.kid}";alg="Ed25519";nonce="${input.nonce}";tag="${input.tag}"`;
  const signature = sign(null, Buffer.from(signatureBase(input.authority, input.path, params)), input.key.privateKey).toString("base64");
  return { "Signature-Input": `sig2=${params}`, Signature: `sig2=:${signature}:` };
}

/** A fresh 64-byte nonce, base64, as the TAP examples carry. */
export const newNonce = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64");

/** Signs a body object (agentic payment container, consumer recognition): every field in order, the signature last. */
export function signObject<T extends Record<string, unknown>>(key: TapKey, object: T): T & { kid: string; alg: "Ed25519"; signature: string } {
  const unsigned = { ...object, kid: key.kid, alg: "Ed25519" as const };
  const signature = sign(null, Buffer.from(JSON.stringify(unsigned)), key.privateKey).toString("base64");
  return { ...unsigned, signature };
}

/** Checks a signed body object against a public key: the same fields, in the order received, without the signature. */
export function verifyObject(object: Record<string, unknown>, publicKey: KeyObject): boolean {
  const { signature, ...unsigned } = object;
  if (typeof signature !== "string") return false;
  try {
    return verify(null, Buffer.from(JSON.stringify(unsigned)), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

interface ParsedInput {
  label: string;
  components: string[];
  params: Record<string, string | number>;
  /** The header's own text after `label=`: the signature base uses it exactly as received. */
  raw: string;
}

/** Parses a `Signature-Input` dictionary member: `label=("c1" "c2");k=v;k="v"`. Whitespace between parameters is tolerated. */
export function parseSignatureInput(header: string): ParsedInput | null {
  const match = header.trim().match(/^([a-z][a-z0-9_.*-]*)=(\((?:\s*"[^"]*"\s*)*\)(?:\s*;\s*[a-z][a-z0-9_.*-]*=(?:"[^"]*"|-?\d+))*)\s*$/i);
  if (!match) return null;
  const [, label, raw] = match as unknown as [string, string, string];
  const components = [...raw.slice(0, raw.indexOf(")")).matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const params: Record<string, string | number> = {};
  for (const m of raw.slice(raw.indexOf(")") + 1).matchAll(/;\s*([a-z][a-z0-9_.*-]*)=("([^"]*)"|-?\d+)/gi)) {
    params[m[1]!.toLowerCase()] = m[3] !== undefined ? m[3] : Number(m[2]);
  }
  return { label, components, params, raw };
}

export type TapVerdict =
  | { ok: true; kid: string; tag: TapTag; nonce: string; created: number; expires: number }
  | { ok: false; reason: string };

/**
 * A merchant's side of TAP, step by step as the specification lists them: a TAP tag, the minimum fields, the
 * eight-minute window, a nonce never seen in that window, a known key, and a signature over the request as received.
 */
export class TapVerifier {
  private readonly nonces = new Map<string, number>();

  constructor(
    private readonly keys: (kid: string) => KeyObject | null,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  verify(request: Request, expect?: TapTag): TapVerdict {
    const inputHeader = request.headers.get("signature-input");
    const signatureHeader = request.headers.get("signature");
    if (!inputHeader || !signatureHeader) return { ok: false, reason: "no message signature: not a trusted agent" };
    const input = parseSignatureInput(inputHeader);
    if (!input) return { ok: false, reason: "the Signature-Input header is malformed" };
    const tag = input.params.tag;
    if (typeof tag !== "string" || !TAP_TAGS.includes(tag as TapTag)) return { ok: false, reason: "the signature carries no agent-browser-auth or agent-payer-auth tag" };
    if (expect && tag !== expect) return { ok: false, reason: `the signature is tagged ${tag}, not ${expect}` };
    for (const field of ["created", "expires", "keyid", "alg", "nonce", "tag"]) {
      if (input.params[field] === undefined) return { ok: false, reason: `the signature is missing ${field}` };
    }
    if (!input.components.includes("@authority") || !input.components.includes("@path")) {
      return { ok: false, reason: "the signature does not cover @authority and @path" };
    }
    const { created, expires, keyid, alg, nonce } = input.params as { created: number; expires: number; keyid: string; alg: string; nonce: string };
    if (typeof created !== "number" || typeof expires !== "number") return { ok: false, reason: "created and expires must be timestamps" };
    const now = this.now();
    if (expires - created > TAP_WINDOW_SECONDS) return { ok: false, reason: "created and expires are more than eight minutes apart" };
    if (created > now + SKEW_SECONDS) return { ok: false, reason: "the signature was created in the future" };
    if (expires <= now) return { ok: false, reason: "the signature has expired" };
    if (String(alg).toLowerCase() !== "ed25519") return { ok: false, reason: `algorithm ${alg} is not supported here` };
    this.forget(now);
    if (this.nonces.has(nonce)) return { ok: false, reason: "this nonce was already used: a replay" };
    const publicKey = this.keys(keyid);
    if (!publicKey) return { ok: false, reason: `no public key for keyid ${keyid}` };
    const signature = signatureHeader.trim().match(new RegExp(`(?:^|,)\\s*${input.label}=:([A-Za-z0-9+/=]+):`))?.[1];
    if (!signature) return { ok: false, reason: `no signature labelled ${input.label}` };
    const url = new URL(request.url);
    const authority = request.headers.get("host") ?? url.host;
    let valid = false;
    try {
      valid = verify(null, Buffer.from(signatureBase(authority, url.pathname, input.raw)), publicKey, Buffer.from(signature, "base64"));
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: "the signature does not match the request" };
    this.nonces.set(nonce, now);
    return { ok: true, kid: keyid, tag: tag as TapTag, nonce, created, expires };
  }

  private forget(now: number): void {
    for (const [nonce, seen] of this.nonces) if (now - seen > TAP_WINDOW_SECONDS) this.nonces.delete(nonce);
  }
}
