import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Hex } from "../canonical";
import type { SignedCertificate } from "./certificate";

export const signCertificateHash = (hash: string, secret: string): string =>
  createHmac("sha256", secret).update(`tessera-certificate-v1|${hash}`).digest("hex");

export function verifyCertificate(certificate: SignedCertificate, secret: string): boolean {
  if (sha256Hex(canonicalJson(certificate.body)) !== certificate.hash) return false;
  const expected = Buffer.from(signCertificateHash(certificate.hash, secret), "hex");
  const actual = Buffer.from(certificate.signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
