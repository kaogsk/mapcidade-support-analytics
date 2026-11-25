// Brasília time (UTC-03:00, no daylight saving since 2019).
//
// The dashboard is read by people in Brasília, so "a day" always means a Brasília
// calendar day — no matter where the process runs. Two real bugs motivated keeping
// every conversion in this one module, with a FIXED offset and no dependency on the
// process timezone:
//
//   1. `new Date("2026-08-31")` is midnight UTC = 21:00 of the PREVIOUS day in
//      Brasília. Every period started 3 hours early and swallowed the evening before.
//   2. Grouping by the UTC day pushed every ticket created after 21:00 into the next
//      day, so "today" lost its last 3 hours across the whole history.
//
// The test suite runs with TZ=Asia/Tokyo so a stray local-time call shows up.

export const BRT_OFFSET = "-03:00";
export const BRT_OFFSET_MS = -3 * 3600_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shift an instant so that its UTC components read as Brasília wall-clock time. */
function asBrtWallClock(instant: Date): Date {
  return new Date(instant.getTime() + BRT_OFFSET_MS);
}

/** Brasília calendar day (YYYY-MM-DD) of an instant, optionally shifted by n days. */
export function brDay(instant: Date, addDays = 0): string {
  const d = asBrtWallClock(instant);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}

/** Wall-clock parts in Brasília. `dow`: 0 = Sunday ... 6 = Saturday. */
export function brParts(instant: Date) {
  const d = asBrtWallClock(instant);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

/** Midnight in Brasília of a YYYY-MM-DD day, as an instant. */
export function brMidnight(day: string): Date {
  if (!DAY_RE.test(day)) throw new Error(`invalid day: ${day}`);
  return new Date(`${day}T00:00:00${BRT_OFFSET}`);
}

/** A Brasília wall-clock time on a given day, as an instant. */
export function brAt(day: string, hour: number, minute = 0): Date {
  return new Date(brMidnight(day).getTime() + (hour * 60 + minute) * 60_000);
}

/** Calendar arithmetic on YYYY-MM-DD strings (timezone-free). */
export function addDaysISO(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse a period bound from the query string. A bare day means midnight in
 * Brasília; anything else must be a full ISO instant. Invalid -> null.
 */
export function parseDay(s: unknown): Date | null {
  if (s == null) return null;
  const v = String(s).trim();
  if (!v) return null;
  if (DAY_RE.test(v)) return brMidnight(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface Period {
  from: string; // ISO instant, inclusive
  to: string; // ISO instant, EXCLUSIVE
}

/**
 * `{from, to}` from the query string. `to` is exclusive: the frontend sends the day
 * AFTER the last included day. Missing `to` = now; missing `from` = 30 days before `to`.
 */
export function resolvePeriod(qs: { from?: unknown; to?: unknown }, now: Date): Period {
  const to = parseDay(qs.to) ?? now;
  const from = parseDay(qs.from) ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from.getTime() > to.getTime()) {
    throw new RangeError("`from` must not be after `to`");
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * The rolling "last N days" window, today included: [today - N + 1, tomorrow) in
 * Brasília days. Same rule as the frontend presets — the number on a card shared as a
 * `?days=30` link must match the dashboard.
 */
export function periodFromDays(days: number, now: Date): Period {
  const n = Math.min(Math.max(Math.trunc(Number(days)) || 30, 1), 366);
  return {
    from: brMidnight(brDay(now, -(n - 1))).toISOString(),
    to: brMidnight(brDay(now, 1)).toISOString(),
  };
}

/** Next instant (strictly after `now`) at which Brasília wall clock reads HH:MM. */
export function nextBrtTime(now: Date, hhmm: string): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid HH:MM: ${hhmm}`);
  const today = brDay(now);
  const candidate = brAt(today, Number(m[1]), Number(m[2]));
  return candidate.getTime() > now.getTime() ? candidate : brAt(addDaysISO(today, 1), Number(m[1]), Number(m[2]));
}
