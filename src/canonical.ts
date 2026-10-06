/** Deterministic JSON: sorted keys, `undefined` dropped. Used for MACs and the event hash chain. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${body.join(",")}}`;
}

export const sha256Hex = (input: string): string =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex");
