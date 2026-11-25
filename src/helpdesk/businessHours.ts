// Business-hours calendar the ticketing API uses for SLA deadlines and "working
// minutes": Monday-Friday, 08:00-18:00 Brasília. Lives on the helpdesk side of the
// fence — the dashboard never recomputes SLA deadlines, it reads `slaResponseDate` /
// `slaSolutionDate` / `lifeTimeWorkingTime` as the source of truth, exactly like the
// real integration. The fake API needs it to produce believable values.
import { addDaysISO, brAt, brDay, brParts } from "../time/brt.js";

export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 18;
const MIN = 60_000;

function isBusinessDay(day: string): boolean {
  const dow = brParts(brAt(day, 12)).dow;
  return dow >= 1 && dow <= 5;
}

/** Working window [open, close) of a Brasília day, or null on weekends. */
function windowOf(day: string): [number, number] | null {
  if (!isBusinessDay(day)) return null;
  return [brAt(day, OPEN_HOUR).getTime(), brAt(day, CLOSE_HOUR).getTime()];
}

/** Add `minutes` of business time to `start`. */
export function addBusinessMinutes(start: Date, minutes: number): Date {
  let remaining = Math.max(0, minutes) * MIN;
  let cursor = start.getTime();
  let day = brDay(start);
  for (let guard = 0; guard < 3660; guard++) {
    const w = windowOf(day);
    if (w) {
      const from = Math.max(cursor, w[0]);
      if (from < w[1]) {
        const available = w[1] - from;
        if (remaining <= available) return new Date(from + remaining);
        remaining -= available;
      }
    }
    day = addDaysISO(day, 1);
    cursor = brAt(day, 0).getTime();
  }
  throw new Error("addBusinessMinutes: horizon exceeded");
}

/** Business minutes between two instants (0 when `end` <= `start`). */
export function businessMinutesBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;
  let total = 0;
  let day = brDay(start);
  const lastDay = brDay(end);
  for (let guard = 0; guard < 3660; guard++) {
    const w = windowOf(day);
    if (w) {
      const from = Math.max(start.getTime(), w[0]);
      const to = Math.min(end.getTime(), w[1]);
      if (to > from) total += to - from;
    }
    if (day === lastDay) break;
    day = addDaysISO(day, 1);
  }
  return Math.round(total / MIN);
}
