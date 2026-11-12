import { ago, money, shortHash } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { ATTEMPT_CHIP, Chip, Kicker, Tile } from "../kit/widgets";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <Kicker>{label}</Kicker>
      <dd className="readout mt-1 truncate text-[12.5px]">{children}</dd>
    </div>
  );
}

/** Every attempt to pay, oldest first, on a spine. Only the newest is ever allowed to still be open. */
export function AttemptsRail({ attempts }: { attempts: IncidentView["attempts"] }) {
  if (attempts.length === 0) return <p className="well rounded-[18px]! px-4 py-6 text-center text-[13px] text-fg/55">No payment has been attempted yet.</p>;
  return (
    <>
      <ol>
        {attempts.map((a, i) => {
          const chip = ATTEMPT_CHIP[a.state];
          const last = i === attempts.length - 1;
          return (
            <li key={a.id} className="flex gap-3">
              <div className="flex w-8 shrink-0 flex-col items-center">
                <span className={`readout flex size-8 items-center justify-center rounded-[10px] text-[11px] font-medium ${last ? "tile inverse text-fg" : "well text-fg/50"}`}>{String(a.seq).padStart(2, "0")}</span>
                {!last ? <span aria-hidden className="my-1 w-[2px] flex-1 rounded-full bg-fg/12" /> : null}
              </div>
              <Tile as="article" className={`mb-3 flex-1 rounded-[20px]! px-4 py-3.5 ${last ? "ring-1 ring-accent/25" : ""}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="readout text-[20px] font-medium tracking-[-0.03em]">{money(a.amountMinor, a.currency)}</span>
                  <Chip tone={chip.tone} pulse={chip.pulse}>
                    {chip.label}
                  </Chip>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-3">
                  <Fact label="Airwallex">{a.awxStatus ?? "no word"}</Fact>
                  <Fact label="Rail">{a.method}</Fact>
                  <Fact label="Fee">{a.feeMinor === null ? "unknown" : money(a.feeMinor, a.currency)}</Fact>
                  <Fact label="Request">{shortHash(a.requestId, 8)}</Fact>
                  <Fact label="Started">
                    <span suppressHydrationWarning>{ago(a.createdAt)}</span>
                  </Fact>
                  {a.failureCode ? (
                    <Fact label="Failure">
                      <span className="text-bad" title={a.failureMessage ?? undefined}>
                        {a.failureCode}
                      </span>
                    </Fact>
                  ) : null}
                </dl>
                {a.lastError ? <p className="well mt-3 rounded-[12px]! px-3 py-2 text-[12px] leading-relaxed text-fg/60">{a.lastError}</p> : null}
              </Tile>
            </li>
          );
        })}
      </ol>
      <p className="mt-1 pl-11 text-[12px] leading-relaxed text-fg/45">
        Only the newest attempt may still be moving. Each is sealed in the ledger before it is sent, so the same invoice can never be paid twice by accident.
      </p>
    </>
  );
}
