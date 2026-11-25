// Synthetic ticket world behind the fake ticketing API.
//
// Each ticket is generated ONCE as a creation instant plus a timeline of future events
// (assignments, replies, status changes, survey answer, deletion). What the API returns
// is that timeline folded up to the simulated "now" — so moving the clock forward makes
// tickets appear, get answered, escalate, leave the support teams, close, get rated or
// get deleted, exactly the kind of churn the incremental sync and the reconcile job
// have to keep up with. Deterministic for a given seed and anchor date.
import { OUTSIDE_TEAMS, TEAMS } from "../config.js";
import { addDaysISO, brAt, brDay } from "../time/brt.js";
import { addBusinessMinutes, businessMinutesBetween } from "./businessHours.js";
import {
  STATUS_TEXT,
  type ActionPayload,
  type BaseStatus,
  type ClientRef,
  type OwnerHistoryPayload,
  type PersonRef,
  type StatusHistoryPayload,
  type SurveyResponsePayload,
  type TicketPayload,
} from "./types.js";

// ── Deterministic randomness ────────────────────────────────────────────────
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: Rng, p: number) => r() < p;
function weighted<T extends { w: number }>(r: Rng, xs: readonly T[]): T {
  const total = xs.reduce((s, x) => s + x.w, 0);
  let x = r() * total;
  for (const it of xs) {
    x -= it.w;
    if (x <= 0) return it;
  }
  return xs[xs.length - 1];
}
function gaussian(r: Rng): number {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
const lognormal = (r: Rng, median: number, sigma: number) => median * Math.exp(sigma * gaussian(r));

// ── Fictional cast ──────────────────────────────────────────────────────────
export interface Analyst {
  id: string;
  name: string;
  team: string;
  /** Moves to another team `daysAgo` days before the generation anchor. */
  promotion?: { team: string; daysAgo: number };
  /** Multiplies response/resolution times (1 = typical). */
  pace: number;
  /** Probability multiplier for reopen and low survey score (1 = typical). */
  slip: number;
}

export const ROSTER: Analyst[] = [
  { id: "a-101", name: "Helena Duarte", team: TEAMS.N1, pace: 0.8, slip: 0.7 },
  { id: "a-102", name: "Rafael Moura", team: TEAMS.N1, pace: 1.9, slip: 1.1 },
  { id: "a-103", name: "Bianca Torres", team: TEAMS.N1, pace: 1.0, slip: 1.0 },
  { id: "a-104", name: "Igor Valente", team: TEAMS.N1, pace: 0.9, slip: 0.8, promotion: { team: TEAMS.N2, daysAgo: 45 } },
  { id: "a-105", name: "Nina Farias", team: TEAMS.N1, pace: 1.1, slip: 2.6 },
  { id: "a-201", name: "Lara Quintana", team: TEAMS.TRIAGE, pace: 1.0, slip: 1.0 },
  { id: "a-202", name: "Davi Rocha", team: TEAMS.TRIAGE, pace: 1.0, slip: 1.0 },
  { id: "a-301", name: "Otávio Brandão", team: TEAMS.N2, pace: 1.0, slip: 0.9 },
  { id: "a-302", name: "Marina Leal", team: TEAMS.N2, pace: 1.3, slip: 1.2 },
  { id: "a-303", name: "Caio Mendonça", team: TEAMS.N2, pace: 0.9, slip: 1.0 },
  { id: "a-401", name: "Sofia Lacerda", team: TEAMS.N3, pace: 1.0, slip: 1.0 },
  { id: "a-402", name: "Renan Gusmão", team: TEAMS.N3, pace: 1.2, slip: 1.0 },
];

const OUTSIDE_PEOPLE: PersonRef[] = [
  { id: "o-901", businessName: "Pat Kowalski", profileType: 3 },
  { id: "o-902", businessName: "Sam Okafor", profileType: 3 },
];

/** Customer organizations. Raw names are messy on purpose (the mapper normalizes). */
export const CITIES = [
  { city: "Rivermeadow", org: "CITY HALL OF RIVERMEADOW", w: 16 },
  { city: "Lakeside", org: "Municipality of Lakeside", w: 12 },
  { city: "Oakwood", org: "CITY HALL OF OAKWOOD", w: 11 },
  { city: "Pinecrest Vale", org: "City Council of Pinecrest Vale", w: 8 },
  { city: "Stonebridge Hollow", org: "TOWN OF STONEBRIDGE HOLLOW", w: 7 },
  { city: "Maplewood Glade", org: "City Hall of Maplewood Glade", w: 7 },
  { city: "Silverlake Reach", org: "MUNICIPALITY OF SILVERLAKE REACH", w: 6 },
  { city: "Fairhaven Rise", org: "City Hall of Fairhaven Rise", w: 5 },
  { city: "Cedar Lantern", org: "CITY HALL OF CEDAR LANTERN", w: 5 },
  { city: "Brookfield Ridge", org: "Town of Brookfield Ridge", w: 4 },
  { city: "Highmont", org: "City Hall of Highmont", w: 3 },
  { city: "Westvale", org: "MUNICIPALITY OF WESTVALE", w: 2 },
] as const;

export const VENDOR_ORG = { id: "org-vendor", businessName: "MapCidade" };

const CONTACT_NAMES = [
  "Avery Collins", "Jordan Blake", "Morgan Reyes", "Taylor Quinn", "Riley Hart",
  "Casey Lund", "Drew Fenwick", "Quinn Abernathy", "Jamie Thorne", "Robin Ashby",
];

/** Business-minute targets per urgency (first response, solution). */
export const SLA_POLICY: Record<string, { response: number; solution: number }> = {
  Critical: { response: 30, solution: 8 * 60 },
  High: { response: 60, solution: 16 * 60 },
  Medium: { response: 120, solution: 24 * 60 },
  Low: { response: 240, solution: 40 * 60 },
};

const URGENCIES = [
  { v: "Low", w: 25 },
  { v: "Medium", w: 50 },
  { v: "High", w: 20 },
  { v: "Critical", w: 5 },
];

const SERVICES = [
  { v: "GIS Viewer", w: 30 },
  { v: "GISWeb", w: 4 }, // legacy alias of "GIS Viewer" used by onboarding projects
  { v: "Permits Workflow", w: 18 },
  { v: "Property Registry", w: 16 },
  { v: "Field Mobile App", w: 12 },
  { v: "Certificates Portal", w: 12 },
  { v: "Citizen Portal", w: 8 },
];

const CATEGORIES: Record<"N1" | "N2" | "N3", { v: string; w: number; subjects: string[] }[]> = {
  N1: [
    { v: "Corrective Maintenance - N1 - Simple", w: 30, subjects: ["Map layer not loading", "Parcel search returns no results", "Login loop on the viewer", "Print layout cuts the legend"] },
    { v: "Corrective Maintenance - N1 - Complex", w: 10, subjects: ["Certificate PDF shows the wrong address", "Field app does not sync photos"] },
    { v: "Adaptive Maintenance - N1 - Simple", w: 12, subjects: ["Add a field to the inspection form", "Change the default map zoom"] },
    { v: "Question", w: 22, subjects: ["How do I export the parcel list?", "Question about the zoning layer", "How to reset a user password"] },
    { v: "Data Request", w: 14, subjects: ["Update building footprints", "Load new street names", "Refresh aerial imagery"] },
    { v: "Training", w: 6, subjects: ["Training for new permit clerks", "Refresher on the field app"] },
  ],
  N2: [
    { v: "Corrective Maintenance - N2 - Complex", w: 40, subjects: ["Permit workflow stuck at review", "Tax map export times out", "Duplicated parcels after import"] },
    { v: "Corrective Maintenance - N2 - Critical", w: 12, subjects: ["Viewer down for all users", "Certificates portal returns error 500"] },
    { v: "Adaptive Maintenance - N2 - Complex", w: 25, subjects: ["New rule for permit fees", "Integrate the registry with the tax system"] },
  ],
  N3: [
    { v: "Evolutionary Maintenance", w: 40, subjects: ["New dashboard for inspections", "Bulk edit for parcel attributes"] },
    { v: "Ideas", w: 60, subjects: ["Suggestion: dark mode for the viewer", "Idea: notify citizens by SMS"] },
  ],
};

// ── Timeline model ──────────────────────────────────────────────────────────
type Ev =
  | { k: "assign"; at: number; team: string; owner: PersonRef | null; by: PersonRef | null }
  | { k: "status"; at: number; s: BaseStatus; by: PersonRef | null; justification?: string }
  | { k: "action"; at: number; type: 1 | 2; origin: number; by: PersonRef; deleted?: boolean }
  | { k: "survey"; at: number; score: number }
  | { k: "delete"; at: number };

export interface SeedTicket {
  id: number;
  created: number;
  subject: string;
  category: string;
  urgency: string;
  origin: number;
  service: string;
  clients: ClientRef[];
  slaResponse: number;
  slaSolution: number;
  events: Ev[];
}

export interface World {
  anchor: Date;
  roster: Analyst[];
  tickets: SeedTicket[];
}

const asPerson = (a: Analyst): PersonRef => ({ id: a.id, businessName: a.name, profileType: 3 });

/** Team an analyst belongs to at a given instant (promotions move people). */
export function teamAt(a: Analyst, at: number, anchor: Date): string {
  if (a.promotion && at >= anchor.getTime() - a.promotion.daysAgo * 86_400_000) return a.promotion.team;
  return a.team;
}

function staffOf(team: string, at: number, anchor: Date, roster: Analyst[]): Analyst[] {
  return roster.filter((a) => teamAt(a, at, anchor) === team);
}

/** Creation instant on a Brasília day: mostly office hours, a real tail of evenings. */
function creationTime(r: Rng, day: string): number {
  const x = r();
  let hour: number;
  if (x < 0.82) hour = int(r, 8, 17);
  else if (x < 0.95) hour = int(r, 18, 23); // the 21:00-24:00 slice is where UTC-day bucketing breaks
  else hour = int(r, 0, 7);
  return brAt(day, hour, int(r, 0, 59)).getTime() + int(r, 0, 59) * 1000;
}

const biz = (t: number, minutes: number) => addBusinessMinutes(new Date(t), minutes).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function buildTicket(r: Rng, id: number, created: number, anchor: Date, roster: Analyst[]): SeedTicket {
  const ev: Ev[] = [];
  const place = weighted(r, CITIES);
  const vendorOnly = chance(r, 0.03);
  const contact: ClientRef = vendorOnly
    ? { id: "cl-vendor-1", businessName: "Internal QA", profileType: 2, organization: VENDOR_ORG }
    : {
        id: `cl-${place.city.toLowerCase().replace(/\s+/g, "-")}-${int(r, 1, 4)}`,
        businessName: pick(r, CONTACT_NAMES),
        profileType: 2,
        organization: { id: `org-${place.city.toLowerCase().replace(/\s+/g, "-")}`, businessName: place.org },
      };
  const clients: ClientRef[] = [contact];
  // Vendor staff copied on the ticket must never be mistaken for the customer.
  if (!vendorOnly && chance(r, 0.15)) {
    clients.unshift({ id: "cl-vendor-2", businessName: "Onboarding Desk", profileType: 2, organization: VENDOR_ORG });
  }

  // Entry route.
  const route = r();
  const level: "N1" | "N2" | "N3" = route < 0.83 ? "N1" : route < 0.95 ? "N2" : "N3";
  const cat = weighted(r, CATEGORIES[level]);
  const urgency = weighted(r, URGENCIES).v;
  const policy = SLA_POLICY[urgency];
  const t: SeedTicket = {
    id,
    created,
    subject: pick(r, cat.subjects),
    category: cat.v,
    urgency,
    origin: pick(r, [1, 1, 3, 3, 3, 4]),
    service: weighted(r, SERVICES).v,
    clients,
    slaResponse: biz(created, policy.response),
    slaSolution: biz(created, policy.solution),
    events: ev,
  };

  let now = created;
  const firstTeam = level === "N1" && route < 0.25 ? TEAMS.TRIAGE : TEAMS[level];
  let staff = staffOf(firstTeam, now, anchor, roster);
  let owner = pick(r, staff);
  ev.push({ k: "assign", at: now, team: firstTeam, owner: asPerson(owner), by: null });

  // Automatic acknowledgement posted through the API with the owner's account:
  // public, origin 9 — it is NOT a human first response.
  if (chance(r, 0.3)) ev.push({ k: "action", at: now + 5000, type: 2, origin: 9, by: asPerson(owner) });

  if (firstTeam === TEAMS.TRIAGE) {
    now += int(r, 8, 110) * 60_000;
    const triager = asPerson(owner);
    staff = staffOf(TEAMS.N1, now, anchor, roster);
    owner = pick(r, staff);
    ev.push({ k: "assign", at: now, team: TEAMS.N1, owner: asPerson(owner), by: triager });
  }

  // Cancellation (duplicate opened by mistake, customer gave up).
  if (chance(r, 0.03)) {
    const at = now + int(r, 10, 600) * 60_000;
    ev.push({ k: "status", at, s: "Canceled", by: asPerson(owner), justification: "Duplicate" });
    return finish(r, t, ev);
  }

  // Internal note before the first public reply: the helpdesk counts it as "response",
  // the dashboard does not (the customer never saw it).
  if (chance(r, 0.08)) ev.push({ k: "action", at: now + int(r, 2, 20) * 60_000, type: 1, origin: 2, by: asPerson(owner) });

  // Never answered (stays in the backlog and ages).
  if (chance(r, 0.015)) return finish(r, t, ev);

  const level3 = TEAMS[level] === TEAMS.N3;
  const respMinutes = Math.max(3, lognormal(r, policy.response * 0.45 * owner.pace, 0.9));
  const firstReply = biz(now, respMinutes);
  if (chance(r, 0.03)) {
    // A reply posted and deleted a few minutes later (wrong ticket).
    ev.push({ k: "action", at: firstReply - 6 * 60_000, type: 2, origin: 2, by: asPerson(owner), deleted: true });
  }
  ev.push({ k: "action", at: firstReply, type: 2, origin: pick(r, [2, 2, 3]), by: asPerson(owner) });
  ev.push({ k: "status", at: firstReply, s: "InAttendance", by: asPerson(owner) });
  now = firstReply;

  // Solved at first contact.
  const isSimple = /Simple|Question/.test(t.category);
  if (isSimple && chance(r, 0.18)) {
    ev.push({ k: "status", at: now + 60_000, s: "Resolved", by: asPerson(owner) });
    closeAndRate(r, t, ev, now + 60_000, owner);
    return finish(r, t, ev);
  }

  // Escalation N1 -> N2 -> N3, or hand-over to a team outside support.
  let currentTeam = TEAMS[level] as string;
  let outsider: PersonRef | null = null;
  if (currentTeam === TEAMS.N1 && chance(r, 0.15)) {
    now += int(r, 1, 30) * HOUR;
    const from = asPerson(owner);
    owner = pick(r, staffOf(TEAMS.N2, now, anchor, roster));
    currentTeam = TEAMS.N2;
    ev.push({ k: "assign", at: now, team: TEAMS.N2, owner: asPerson(owner), by: from });
  }
  if (currentTeam === TEAMS.N2 && chance(r, 0.08)) {
    now += int(r, 4, 72) * HOUR;
    const from = asPerson(owner);
    owner = pick(r, staffOf(TEAMS.N3, now, anchor, roster));
    currentTeam = TEAMS.N3;
    ev.push({ k: "assign", at: now, team: TEAMS.N3, owner: asPerson(owner), by: from });
  }
  if (chance(r, 0.04)) {
    now += int(r, 2, 48) * HOUR;
    outsider = pick(r, OUTSIDE_PEOPLE);
    ev.push({ k: "assign", at: now, team: pick(r, OUTSIDE_TEAMS), owner: chance(r, 0.5) ? outsider : null, by: asPerson(owner) });
  }

  // Waiting on the customer for a while.
  if (chance(r, 0.2)) {
    const stopAt = now + int(r, 1, 20) * HOUR;
    ev.push({ k: "status", at: stopAt, s: "Stopped", by: asPerson(owner), justification: "Waiting on customer" });
    const back = stopAt + int(r, 4, 96) * HOUR;
    ev.push({ k: "action", at: back, type: 2, origin: 3, by: contact });
    ev.push({ k: "status", at: back, s: "InAttendance", by: null });
    now = back;
  }

  const multiplier = level3 || currentTeam === TEAMS.N3 ? 7 : currentTeam === TEAMS.N2 ? 1.6 : 1;
  const solveMinutes = Math.max(20, lognormal(r, policy.solution * 0.5 * owner.pace * multiplier, 0.85));
  let resolvedAt = Math.max(biz(created, solveMinutes), now + 10 * 60_000);
  const resolver = outsider ?? asPerson(owner);
  ev.push({ k: "action", at: resolvedAt, type: 2, origin: 2, by: resolver });

  // Closed straight away by the agent (never passes through Resolved).
  if (chance(r, 0.08)) {
    ev.push({ k: "status", at: resolvedAt, s: "Closed", by: resolver });
    rate(r, t, ev, resolvedAt, owner);
    return finish(r, t, ev);
  }
  ev.push({ k: "status", at: resolvedAt, s: "Resolved", by: resolver });

  // Reopen by the CUSTOMER (counts) or by the agent to fix a typo / log hours (doesn't).
  if (chance(r, 0.06 * owner.slip)) {
    const at = resolvedAt + int(r, 6, 60) * HOUR;
    ev.push({ k: "action", at, type: 2, origin: 3, by: contact });
    ev.push({ k: "status", at, s: "InAttendance", by: contact });
    resolvedAt = at + int(r, 2, 40) * HOUR;
    ev.push({ k: "status", at: resolvedAt, s: "Resolved", by: resolver });
  } else if (chance(r, 0.03)) {
    const at = resolvedAt + int(r, 1, 20) * HOUR;
    ev.push({ k: "status", at, s: "InAttendance", by: resolver });
    resolvedAt = at + 25 * 60_000;
    ev.push({ k: "status", at: resolvedAt, s: "Resolved", by: resolver });
  }
  closeAndRate(r, t, ev, resolvedAt, owner);
  return finish(r, t, ev);
}

function closeAndRate(r: Rng, _t: SeedTicket, ev: Ev[], resolvedAt: number, owner: Analyst) {
  const closedAt = resolvedAt + 3 * DAY; // closed by the system after 3 days
  ev.push({ k: "status", at: closedAt, s: "Closed", by: null });
  rate(r, _t, ev, closedAt, owner);
}

function rate(r: Rng, _t: SeedTicket, ev: Ev[], closedAt: number, owner: Analyst) {
  if (!chance(r, 0.45)) return;
  const low = chance(r, Math.min(0.6, 0.09 * owner.slip));
  const score = low ? int(r, 0, 7) : weighted(r, [{ v: 10, w: 75 }, { v: 9, w: 15 }, { v: 8, w: 10 }]).v;
  ev.push({ k: "survey", at: closedAt + int(r, 1, 96) * HOUR, score });
}

function finish(r: Rng, t: SeedTicket, ev: Ev[]): SeedTicket {
  // Deleted / merged into another ticket at some point.
  if (chance(r, 0.008)) ev.push({ k: "delete", at: t.created + int(r, 1, 20) * DAY });
  ev.sort((a, b) => a.at - b.at);
  return t;
}

export interface WorldOptions {
  anchor: Date;
  seed: number;
  pastDays?: number;
  futureDays?: number;
  /** Average tickets per business day. */
  perDay?: number;
}

export function generateWorld({ anchor, seed, pastDays = 400, futureDays = 60, perDay = 11 }: WorldOptions): World {
  const r = mulberry32(seed);
  const tickets: SeedTicket[] = [];
  let id = 10_000;
  const first = brDay(anchor, -pastDays);
  for (let i = 0; i <= pastDays + futureDays; i++) {
    const day = addDaysISO(first, i);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const n = weekend ? int(r, 0, 2) : Math.max(0, Math.round(perDay + gaussian(r) * 3));
    const times = Array.from({ length: n }, () => creationTime(r, day)).sort((a, b) => a - b);
    for (const created of times) tickets.push(buildTicket(r, ++id, created, anchor, ROSTER));
  }
  return { anchor, roster: ROSTER, tickets };
}

// ── Folding a timeline into the API payload ─────────────────────────────────
/** Naive UTC timestamp, the way the ticketing API serializes dates. */
export function naive(ms: number | null): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 19);
}

const OPEN: BaseStatus[] = ["New", "InAttendance", "Stopped"];

/** Full payload of a ticket as of `now`, or null if it does not exist (yet / anymore). */
export function materialize(t: SeedTicket, now: number): TicketPayload | null {
  if (t.created > now) return null;
  let team: string | null = null;
  let owner: PersonRef | null = null;
  let base: BaseStatus = "New";
  let resolvedIn: number | null = null;
  let closedIn: number | null = null;
  let canceledIn: number | null = null;
  let reopenedIn: number | null = null;
  let lastUpdate = t.created;
  let firstAgentAny: number | null = null;
  let firstPublicAgent: number | null = null;
  let escalated = false;
  const actions: ActionPayload[] = [];
  const ownerHistories: OwnerHistoryPayload[] = [];
  const statusHistories: StatusHistoryPayload[] = [
    { status: STATUS_TEXT.New, justification: null, changedDate: naive(t.created)!, changedBy: pickClient(t) },
  ];
  const surveys: SurveyResponsePayload[] = [];

  for (const e of t.events) {
    if (e.at > now) break;
    if (e.k === "delete") return null;
    lastUpdate = Math.max(lastUpdate, e.at);
    switch (e.k) {
      case "assign":
        if (team && team !== TEAMS.TRIAGE && team !== e.team) escalated = true;
        team = e.team;
        owner = e.owner;
        ownerHistories.push({ ownerTeam: e.team, owner: e.owner, changedBy: e.by, changedDate: naive(e.at)! });
        break;
      case "action": {
        actions.push({
          id: t.id * 100 + actions.length + 1,
          type: e.type,
          origin: e.origin,
          createdDate: naive(e.at)!,
          isDeleted: Boolean(e.deleted),
          createdBy: e.by.profileType ? { id: e.by.id, profileType: e.by.profileType } : null,
        });
        const isAgent = e.by.profileType === 3;
        if (isAgent && firstAgentAny == null) firstAgentAny = e.at;
        if (isAgent && e.type === 2 && !e.deleted && e.origin !== 9 && firstPublicAgent == null) firstPublicAgent = e.at;
        break;
      }
      case "status": {
        if ((base === "Resolved" || base === "Closed") && OPEN.includes(e.s)) reopenedIn = e.at;
        base = e.s;
        if (e.s === "Resolved") resolvedIn = e.at;
        if (e.s === "Closed") closedIn = e.at;
        if (e.s === "Canceled") canceledIn = e.at;
        statusHistories.push({
          status: STATUS_TEXT[e.s],
          justification: e.justification ?? null,
          changedDate: naive(e.at)!,
          changedBy: e.by ? { id: e.by.id, profileType: e.by.profileType } : null,
        });
        break;
      }
      case "survey":
        surveys.push({
          id: t.id * 10 + surveys.length + 1,
          satisfactionSurveyModel: 3,
          satisfactionSurveyNetPromoterScoreResponse: e.score,
          responseDate: naive(e.at)!,
        });
        break;
    }
  }

  const end = closedIn ?? canceledIn ?? (base === "Resolved" ? resolvedIn : null) ?? now;
  return {
    id: t.id,
    subject: t.subject,
    status: STATUS_TEXT[base],
    baseStatus: base,
    category: t.id % 5 === 0 ? ` ${t.category} ` : t.category, // some categories come padded
    urgency: t.urgency,
    origin: t.origin,
    serviceFirstLevel: t.service,
    ownerTeam: team,
    createdDate: naive(t.created),
    resolvedIn: naive(resolvedIn),
    closedIn: naive(closedIn),
    canceledIn: naive(canceledIn),
    reopenedIn: naive(reopenedIn),
    slaResponseDate: naive(t.slaResponse),
    slaSolutionDate: naive(t.slaSolution),
    slaRealResponseDate: naive(firstAgentAny),
    lastUpdate: naive(lastUpdate),
    resolvedInFirstCall: resolvedIn != null && !escalated && firstPublicAgent != null && resolvedIn - firstPublicAgent <= 120_000,
    lifeTimeWorkingTime: businessMinutesBetween(new Date(t.created), new Date(end)),
    owner,
    clients: t.clients,
    actions,
    statusHistories,
    ownerHistories,
    satisfactionSurveyResponses: surveys,
  };
}

function pickClient(t: SeedTicket): PersonRef {
  const c = t.clients[t.clients.length - 1];
  return { id: c.id, profileType: 2 };
}
