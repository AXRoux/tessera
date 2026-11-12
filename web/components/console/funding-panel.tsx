"use client";

import { useId, useState } from "react";
import { api, ApiProblem } from "@/lib/client-api";
import { money, shortHash, until } from "@/lib/format";
import { FundingQuoteSchema, FundingResultSchema, type FundingQuote, type FundingResultWire, type IncidentView } from "../../../src/server/wire";

import type { RunAction } from "./actions-panel";
import { Field, TextArea, type Notice } from "./fields";
import { Btn } from "../kit/metal";
import { Chip, Kicker } from "../kit/widgets";

/** Mirrors WRITTEN_NOTE_MIN_CHARS (src/approval/approval.ts), only so the button can say why it is disabled. */
const NOTE_MIN = 10;

const STATE_LABEL: Record<IncidentView["conversions"][number]["state"], string> = {
  INTENT: "Outcome unknown",
  BOOKED: "Booked, not settled",
  SETTLED: "Settled",
  CANCELLED: "Cancelled",
  ABANDONED: "Never booked",
};

function booked(result: FundingResultWire, by: string): Notice {
  const c = result.conversion;
  const lines = [
    `Bought ${money(c.buyMinor, c.buyCurrency)} for ${money(c.sellMinor, c.sellCurrency)} (${c.rate} ${c.currencyPair}), ${by}.`,
    c.conversionId ? `Airwallex conversion ${c.conversionId}.` : "Airwallex has not returned a conversion id yet; Tessera looks it up by its request ID.",
    ...result.replans.map((r) => `A quote was thrown away first: ${r}.`),
    c.state === "SETTLED" ? "The money is in the wallet. The recommendation below is now worked out on the new balance." : `The conversion is ${STATE_LABEL[c.state].toLowerCase()}.`,
  ];
  return { tone: c.state === "ABANDONED" ? "refused" : "ok", title: c.state === "ABANDONED" ? "Airwallex refused the conversion" : "Conversion booked", lines };
}

/**
 * Funding a replacement from another wallet. The plan (which wallet, how much, at what indicative rate) is the code's; a
 * person can only ask for it to be booked: automatically when it is within the limit, or by approving one quote they
 * reviewed (step one fetches and records it, step two sends back exactly that quote and its fingerprint).
 */
export function FundingPanel({ view, operator, busy, run }: { view: IncidentView; operator: string; busy: string | null; run: RunAction }) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<FundingQuote | null>(null);
  const decision = view.assessment?.decision;
  const plan = decision?.funding ?? null;
  if (!plan && view.conversions.length === 0) return null;

  const id = view.obligation.id;
  const name = operator.split("@")[0];
  const fundable = Boolean(plan?.feasible && decision?.allowed.includes("FUND"));
  const refusedFund = decision?.blocked.find((b) => b.action === "FUND")?.reason;
  const cur = plan?.currency ?? view.obligation.currency;

  const approve = (reviewed: FundingQuote) =>
    run("fund-approve", async () => {
      try {
        const result = await api(`obligations/${id}/fund/approve`, FundingResultSchema, {
          method: "POST",
          body: { note: note.trim(), evidenceHash: reviewed.evidenceHash, quoteId: reviewed.quoteId, fingerprint: reviewed.fingerprint },
        });
        setNote("");
        return booked(result, `approved by ${operator}`);
      } catch (error) {
        if (error instanceof ApiProblem && (error.problem.code === "stale" || error.problem.code === "stale_evidence")) {
          return {
            tone: "refused",
            title: "That quote can no longer be approved",
            lines: ["Nothing was converted. The incident or the quote changed after you reviewed it.", "Fetch a fresh quote and review it again."],
          };
        }
        throw error;
      } finally {
        setQuote(null);
      }
    });

  return (
    <div className="space-y-4">
        {plan ? <Chip tone={plan.autoApprovable ? "accent" : "neutral"}>{plan.autoApprovable ? "Within the automatic limit" : "Needs a person"}</Chip> : null}
        {plan ? (
          <>
            <ul className="space-y-1 text-[12.5px] leading-relaxed">
              <li>
                {cur} wallet <strong className="readout">{money(plan.availableMinor, cur)}</strong>, reserve floor <span className="readout">{money(plan.floorMinor, cur)}</span>
              </li>
              <li>
                Replacement <span className="readout">{money(plan.neededMinor, cur)}</span> ({money(plan.neededMinor - plan.feeMinor, cur)} plus the {money(plan.feeMinor, cur)} fee)
              </li>
              <li>
                Short by <strong className="readout">{money(plan.shortfallMinor, cur)}</strong>
                {plan.buyMinor > plan.shortfallMinor ? `, rounded up to ${money(plan.buyMinor, cur)}` : ""}
              </li>
            </ul>
            <div>
              <Kicker>Wallets that may fund it, in policy order</Kicker>
              <ul className="mt-2 divide-y divide-fg/10 border-y border-fg/10 text-[12.5px]">
                {plan.sources.map((s) => (
                  <li key={s.currency} className={`grid grid-cols-[48px_1fr_auto] gap-3 px-3 py-2 ${s.ok ? "" : "text-fg/55"}`}>
                    <span className="readout text-[12px] font-medium">{s.currency}</span>
                    <span className="readout">
                      {money(s.availableMinor, s.currency)} / keeps {money(s.floorMinor, s.currency)}
                    </span>
                    <span className="readout">{s.sellMinor === null ? "no rate" : `~${money(s.sellMinor, s.currency)}`}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-[12px] leading-relaxed text-fg/55">{plan.summary}</p>
          </>
        ) : null}

        {plan && fundable && plan.autoApprovable ? (
          <Btn
            block
            busy={busy === "fund"}
            onClick={() =>
              run("fund", async () => booked(await api(`obligations/${id}/fund`, FundingResultSchema, { method: "POST" }), "within the automatic conversion limit"))
            }
          >
            Convert {money(plan.buyMinor, cur)} from {plan.sellCurrency}
          </Btn>
        ) : null}

        {plan && fundable && !plan.autoApprovable ? (
          quote === null ? (
            <div className="space-y-3">
              <p className="text-[12px] leading-relaxed text-fg/55">
                This conversion needs a person. Fetch a live quote first: your signature is bound to that quote, those wallets and the facts you reviewed.
              </p>
              <Btn
                tone="secondary"
                block
                busy={busy === "fund-quote"}
                onClick={() =>
                  run("fund-quote", async () => {
                    setQuote(await api(`obligations/${id}/fund/quote`, FundingQuoteSchema, { method: "POST" }));
                  })
                }
              >
                Get a quote to review
              </Btn>
            </div>
          ) : (
            <div className="well space-y-3 rounded-[18px]! p-4">
              <Kicker className="text-fg">You are approving</Kicker>
              <ul className="space-y-1.5 text-sm leading-relaxed">
                <li>
                  Buy <strong className="readout">{money(quote.buyMinor, quote.buyCurrency)}</strong> for <strong className="readout">{money(quote.sellMinor, quote.sellCurrency)}</strong>
                </li>
                <li>
                  Rate {quote.rate} {quote.currencyPair}, quote {shortHash(quote.quoteId, 8)}, valid for {until(quote.validTo)}
                </li>
                <li>
                  Facts fingerprint <span className="readout text-[12px]">{shortHash(quote.fingerprint, 16)}</span>
                </li>
              </ul>
              <Field label="Why is this conversion right?" htmlFor={noteId} hint={note.trim().length < NOTE_MIN ? `A written note: at least ${NOTE_MIN} characters.` : undefined}>
                <TextArea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Treasury confirmed the rate and the USD wallet can spare it." maxLength={500} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Btn tone="secondary" disabled={busy === "fund-approve"} onClick={() => setQuote(null)}>
                  Back
                </Btn>
                <Btn busy={busy === "fund-approve"} disabled={note.trim().length < NOTE_MIN} onClick={() => void approve(quote)}>
                  Sign as {name}
                </Btn>
              </div>
            </div>
          )
        ) : null}

        {plan && !fundable ? <p className="text-[12px] leading-relaxed text-fg/55">{refusedFund ?? "Converting is not among the safe moves just now."}</p> : null}

        {view.conversions.length > 0 ? (
          <div>
            <Kicker>Conversions for this invoice</Kicker>
            <ul className="mt-3 space-y-2 text-sm">
              {view.conversions.map((c) => (
                <li key={c.id} className="well rounded-[14px]! px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="readout">
                      {money(c.buyMinor, c.buyCurrency)} for {money(c.sellMinor, c.sellCurrency)}
                    </span>
                    <Chip tone={c.state === "SETTLED" ? "accent" : "neutral"}>{STATE_LABEL[c.state]}</Chip>
                  </div>
                  <p className="mt-1 readout text-[11px] text-fg/55">
                    {c.conversionId ?? `request ${shortHash(c.requestId, 8)}`} / {c.rate} {c.currencyPair}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
    </div>
  );
}
