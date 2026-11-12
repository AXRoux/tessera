import { ago, money } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Icon } from "../landing/icons";
import { Kicker, RingSquare, Tile } from "../kit/widgets";

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-fg/[0.06] py-2">
      <span className="text-[12.5px] text-fg/55">{label}</span>
      <span className="readout text-right text-[12.5px] font-medium">{value}</span>
    </div>
  );
}

/** The certificate of completion: issued only once every wallet line ties out against Airwallex. */
export function CertificatePanel({ view }: { view: IncidentView }) {
  const cert = view.certificate;
  if (!cert) {
    return (
      <Tile className="flex flex-col items-center gap-3 rounded-[24px]! px-6 py-8 text-center">
        <RingSquare value={0} size={76} tone="solid">
          <Icon name="badge" className="size-6" />
        </RingSquare>
        <p className="text-[14px] font-semibold">Not yet certified</p>
        <p className="max-w-sm text-[12.5px] leading-relaxed text-fg/55">
          When it is, every wallet line will have been matched against Airwallex. If a single one fails to tie out, Tessera refuses and says precisely why.
        </p>
      </Tile>
    );
  }
  const { totals, currency } = cert.body;
  return (
    <Tile className="rounded-[24px]! p-5">
      <div className="flex items-center gap-4">
        <RingSquare value={1} size={64} tone="accent">
          <Icon name="badge" className="size-5" />
        </RingSquare>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold">Certificate of completion</p>
          <p className="readout mt-1 truncate text-[11px] text-fg/50" title={cert.hash}>
            {cert.hash}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <Line label="Received by the supplier" value={money(totals.paidMinor, currency)} />
        <Line label="Owed" value={money(cert.body.amountMinor, currency)} />
        <Line label="Fees, every attempt" value={money(totals.feesMinor, currency)} />
        <Line label="Refunded after failures" value={money(totals.refundedMinor, currency)} />
        <Line label="Net wallet movement" value={money(totals.netWalletMinor, currency)} />
        <Line label="Issued" value={ago(cert.body.issuedAt)} />
      </div>
      {(cert.body.funding ?? []).map((f) => (
        <div key={f.fundingId} className="mt-4">
          <Kicker>Funded by conversion {f.conversionId ?? f.requestId}</Kicker>
          <Line label={`Bought ${f.buyCurrency}`} value={`${money(f.actual?.buyMinor ?? 0, f.buyCurrency)} of ${money(f.expected.buyMinor, f.buyCurrency)}`} />
          <Line label={`Sold ${f.sellCurrency}`} value={`${money(-(f.actual?.sellMinor ?? 0), f.sellCurrency)} of ${money(-f.expected.sellMinor, f.sellCurrency)}`} />
          <Line label="Rate" value={`${f.rate} ${f.currencyPair}`} />
        </div>
      ))}
      <a
        className="tile mt-4 flex h-10 w-full items-center justify-center rounded-full! text-[13px] font-medium"
        href={`/api/obligations/${view.obligation.id}/certificate`}
        download={`${view.obligation.reference}-certificate.json`}
      >
        Download the certificate
      </a>
    </Tile>
  );
}
