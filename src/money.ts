// Airwallex speaks major units (100 = one hundred dollars). The ledger stores integer minor units.
const EXPONENT: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, UGX: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
};

export const currencyExponent = (currency: string): number => EXPONENT[currency] ?? 2;

export function toMinor(amount: number, currency: string): number {
  const minor = Math.round(amount * 10 ** currencyExponent(currency));
  if (!Number.isSafeInteger(minor)) throw new RangeError(`amount out of range: ${amount} ${currency}`);
  return minor;
}

export const fromMinor = (minor: number, currency: string): number =>
  minor / 10 ** currencyExponent(currency);

/** A display amount such as "$102.00", for sentences a person will read. */
export const formatMinor = (minor: number, currency: string): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(fromMinor(minor, currency));
