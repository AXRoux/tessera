import { ago, money, shortHash } from "@/lib/format";
import { ATTEMPT } from "@/lib/status";
import type { IncidentView } from "../../../src/server/wire";
import { Frame, Label, PanelHeader, Tag } from "../ui";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-rule py-2.5">
      <Label>{label}</Label>
      <span className="text-right text-sm">{children}</span>
    </div>
  );
}

/** Attempts left to right, joined by a line and a square. Only the last one is ever allowed to be open. */
export function AttemptsRail({ attempts }: { attempts: IncidentView["attempts"] }) {
  return (
    <Frame tone="rule">
      <PanelHeader title="Payment attempts" right={<Label>{attempts.length === 1 ? "1 attempt" : `${attempts.length} attempts`}</Label>} />
      <ol className="flex items-stretch overflow-x-auto p-5">
        {attempts.map((a, i) => {
          const look = ATTEMPT[a.state];
          return (
            <li key={a.id} className="flex items-stretch">
              <article className="w-[280px] shrink-0 border border-ink p-5">
                <div className="flex items-center justify-between">
                  <span className="font-display text-xl tnum">{String(a.seq).padStart(2, "0")}</span>
                  <Tag tone={look.tone} pulse={look.pulse}>
                    {look.label}
                  </Tag>
                </div>
                <p className="tnum mt-5 text-2xl font-semibold">{money(a.amountMinor, a.currency)}</p>
                <div className="mt-4">
                  <Row label="Airwallex says">{a.awxStatus ?? "Nothing yet"}</Row>
                  <Row label="Method">{a.method}</Row>
                  <Row label="Fee">{a.feeMinor === null ? "Unknown" : money(a.feeMinor, a.currency)}</Row>
                  {a.failureCode ? (
                    <Row label="Failure">
                      <span className="font-mono text-[13px] font-medium">{a.failureCode}</span>
                      <span className="block text-xs text-muted">{a.failureMessage}</span>
                    </Row>
                  ) : null}
                  <Row label="Request ID">
                    <span className="font-mono text-[12px]">{shortHash(a.requestId, 8)}</span>
                  </Row>
                  <Row label="Started">{ago(a.createdAt)}</Row>
                </div>
                {a.lastError ? <p className="hatch mt-3 px-3 py-2 text-xs leading-relaxed">{a.lastError}</p> : null}
              </article>
              {i < attempts.length - 1 ? (
                <div aria-hidden className="flex w-12 shrink-0 items-center">
                  <span className="h-px flex-1 bg-ink" />
                  <span className="size-2 bg-ink" />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}
