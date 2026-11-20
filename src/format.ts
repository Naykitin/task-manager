/** "1h 23m 45s", "23m 45s", "45s", or "0s". Compact human duration. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

/** "01:23:45" clock style, always HH:MM:SS. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Decimal hours, e.g. 1.75 */
export function formatHours(totalSeconds: number): string {
  return (totalSeconds / 3600).toFixed(2);
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** ISO timestamp -> value for an <input type="datetime-local">, in local time. */
export function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local time) -> ISO UTC timestamp. */
export function fromDatetimeLocal(value: string): string {
  return new Date(value).toISOString();
}

/** Elapsed seconds since an ISO timestamp (never negative). */
export function elapsedSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

/** YYYY-MM-DD in local time. */
export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** First and last day of the month containing `d`, as YYYY-MM-DD. */
export function monthRange(d: Date): { start: string; end: string } {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: toYmd(start), end: toYmd(end) };
}

/** Number of decimal places the currency uses (2 for USD, 0 for JPY). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Minor units (cents) -> "$1,234.50". Falls back to "1234.50 XYZ" for unknown codes. */
export function formatMoney(minor: number, currency: string): string {
  const d = currencyDigits(currency);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 10 ** d);
  } catch {
    return `${(minor / 10 ** d).toFixed(d)} ${currency}`;
  }
}

/** "12.5" typed by the user -> minor units for the currency; null if empty/invalid. */
export function parseMoneyToMinor(text: string, currency: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10 ** currencyDigits(currency));
}

/** Minor units -> editable text such as "50" or "12.50". */
export function minorToInput(minor: number | null, currency: string): string {
  if (minor === null) return "";
  const d = currencyDigits(currency);
  return (minor / 10 ** d).toFixed(d);
}

/** "$100.00 + €50.00", or "" when there is no money. */
export function formatAmounts(amounts: { currency: string; amount_minor: number }[]): string {
  return amounts.map((a) => formatMoney(a.amount_minor, a.currency)).join(" + ");
}
