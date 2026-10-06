import { ago, money } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Frame, Label, PanelHeader } from "../ui";

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-rule py-2.5">
      <Label>{label}</Label>
      <span className="tnum text-right text-sm font-medium">{value}</span>
    </div>
  );
}

export function CertificatePanel({ view }: { view: IncidentView }) {
  const cert = view.certificate;
  if (!cert) {
    return (
      <Frame tone="rule">
        <PanelHeader title="Closure certificate" />
        <div className="hatch px-5 py-8">
          <p className="text-sm leading-relaxed text-muted">
            Not certified. Closing reconciles every wallet line against Airwallex and refuses, with its reasons, if anything does not tie out.
          </p>
        </div>
      </Frame>
    );
  }

  const { totals, currency } = cert.body;
  return (
    <Frame tone="blue">
      <PanelHeader title="Closure certificate" right={<Label className="text-blue">Signed</Label>} />
      <div className="p-5">
        <Label>Hash to anchor</Label>
        <p className="mt-2 break-all font-mono text-[12px] leading-relaxed">{cert.hash}</p>
        <div className="mt-5">
          <Line label="Supplier received" value={money(totals.paidMinor, currency)} />
          <Line label="Owed" value={money(cert.body.amountMinor, currency)} />
          <Line label="Fees across attempts" value={money(totals.feesMinor, currency)} />
          <Line label="Refunded by failures" value={money(totals.refundedMinor, currency)} />
          <Line label="Net wallet movement" value={money(totals.netWalletMinor, currency)} />
          <Line label="Issued" value={ago(cert.body.issuedAt)} />
        </div>
        <a
          className="mt-5 inline-flex h-12 w-full items-center justify-center border border-ink text-[12px] font-medium uppercase tracking-[0.18em] hover:bg-ink hover:text-paper"
          href={`/api/obligations/${view.obligation.id}/certificate`}
          download={`${view.obligation.reference}-certificate.json`}
        >
          Download certificate
        </a>
      </div>
    </Frame>
  );
}
