const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, formatter);
  }
  return formatter;
}

/** Minor units to a display amount, honoring the currency's own number of decimals. */
export function money(minor: number, currency: string): string {
  const formatter = formatterFor(currency);
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(minor / 10 ** digits);
}

/** A display amount to minor units, honoring the currency's own number of decimals. */
export function toMinor(amount: number, currency: string): number {
  const digits = formatterFor(currency).resolvedOptions().maximumFractionDigits ?? 2;
  return Math.round(amount * 10 ** digits);
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Time until `iso`, in words. "now" once it has passed. */
export function until(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (seconds <= 0) return "now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds < 90) return unit(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}

export const shortHash = (hash: string, length = 10): string => hash.slice(0, length);

export const titleCase = (value: string): string =>
  value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
