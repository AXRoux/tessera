/**
 * Fits a create-beneficiary request to Airwallex's live schema before it is sent.
 *
 * `POST /api/v1/beneficiaries/schema` answers, for one partial request, the fields this account requires and what is
 * wrong with the ones given. The answer differs by account, not just by corridor: on one sandbox business (2026-11-14)
 * a US LOCAL beneficiary required `bank_name` and called `bank_account_category` an IRRELEVANT_VALUE, where a newer
 * business required the category. So Tessera asks before it creates: fields the schema calls irrelevant are dropped,
 * and anything missing or invalid stops the create with Airwallex's own words, instead of a bare error code after.
 */

/** Airwallex's answer, as much of it as Tessera reads. */
export interface SchemaAnswer {
  errors?: Record<string, { code?: string; value?: unknown; validation_functions?: Array<{ description?: string }> }>;
  schema?: Record<string, { required?: boolean; relevant?: boolean; type?: string }>;
}

export interface SchemaFit {
  /** The request with every field the schema called irrelevant removed. */
  request: Record<string, unknown>;
  /** Paths removed, relative to the request. */
  dropped: string[];
  /** Why the request would be refused, in Airwallex's words; empty when it fits. */
  problems: string[];
}

const PREFIX = "create_beneficiary_request.";
/** The schema calls the methods `payment_methods`; the create call takes `transfer_methods` (the builder guide's warning). */
const ALIASES: Readonly<Record<string, string>> = { payment_methods: "transfer_methods" };

const relative = (path: string): string => {
  const rest = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path;
  const [head, ...tail] = rest.split(".");
  return [ALIASES[head!] ?? head, ...tail].join(".");
};

function at(value: unknown, path: string): unknown {
  let node: unknown = value;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function remove(value: Record<string, unknown>, path: string): boolean {
  const keys = path.split(".");
  const parent = at(value, keys.slice(0, -1).join("."));
  const last = keys[keys.length - 1]!;
  if (keys.length === 1) return delete value[last];
  if (parent === null || typeof parent !== "object" || !(last in parent)) return false;
  return delete (parent as Record<string, unknown>)[last];
}

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/** The request fitted to the answer: irrelevant fields dropped, and every remaining problem named. */
export function fitToSchema(request: Record<string, unknown>, answer: SchemaAnswer): SchemaFit {
  const fitted = structuredClone(request);
  const dropped: string[] = [];
  const problems: string[] = [];
  for (const [path, error] of Object.entries(answer.errors ?? {})) {
    const field = relative(path);
    if (error.code === "IRRELEVANT_VALUE") {
      if (remove(fitted, field)) dropped.push(field);
      continue;
    }
    const why = (error.validation_functions ?? []).map((f) => f.description).filter(Boolean).join("; ");
    problems.push(`${field}: ${why || error.code || "rejected"}`);
  }
  for (const [path, field] of Object.entries(answer.schema ?? {})) {
    // Leaves only: an object is present when its fields are, and `.item` describes an array's elements.
    if (!field.required || field.relevant === false || field.type === "object" || path.endsWith(".item")) continue;
    const name = relative(path);
    if (!present(at(fitted, name))) problems.push(`${name} is required`);
  }
  return { request: fitted, dropped, problems };
}
