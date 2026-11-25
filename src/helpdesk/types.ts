// Wire format of the ticketing API (OData v4-ish JSON), as the sync service sees it.
//
// Quirks reproduced on purpose because the sync has to survive them:
//  - every date is a NAIVE string ("2026-08-03T20:00:08") that is actually UTC;
//  - `satisfactionSurveyResponses` is always empty in listings, only GET-by-id fills it;
//  - `/tickets` only returns tickets updated in the last 90 days, `/tickets/past` the rest.

export type BaseStatus = "New" | "InAttendance" | "Stopped" | "Resolved" | "Closed" | "Canceled";

/** profileType of a person: 1/3 = agent, 2 = customer. Missing = system. */
export interface PersonRef {
  id: string;
  businessName?: string;
  profileType?: number;
}

export interface OrganizationRef {
  id: string;
  businessName: string;
}

export interface ClientRef extends PersonRef {
  organization?: OrganizationRef | null;
}

export interface ActionPayload {
  id: number;
  /** 1 = internal note, 2 = public reply. */
  type: number;
  /** 2 = web, 3 = e-mail, 9 = API/automation, 4 = trigger. */
  origin: number;
  createdDate: string;
  isDeleted: boolean;
  createdBy: PersonRef | null;
}

export interface StatusHistoryPayload {
  status: string;
  justification: string | null;
  changedDate: string;
  changedBy: PersonRef | null;
}

export interface OwnerHistoryPayload {
  ownerTeam: string | null;
  owner: PersonRef | null;
  changedBy: PersonRef | null;
  changedDate: string;
}

export interface SurveyResponsePayload {
  id: number;
  satisfactionSurveyModel: number;
  satisfactionSurveyNetPromoterScoreResponse: number | null;
  responseDate: string;
}

export interface TicketPayload {
  id: number;
  subject?: string | null;
  status?: string | null;
  baseStatus?: BaseStatus | null;
  category?: string | null;
  urgency?: string | null;
  origin?: number | null;
  serviceFirstLevel?: string | null;
  ownerTeam?: string | null;
  createdDate?: string | null;
  resolvedIn?: string | null;
  closedIn?: string | null;
  canceledIn?: string | null;
  reopenedIn?: string | null;
  slaResponseDate?: string | null;
  slaSolutionDate?: string | null;
  slaRealResponseDate?: string | null;
  lastUpdate?: string | null;
  resolvedInFirstCall?: boolean | null;
  lifeTimeWorkingTime?: number | null;
  owner?: PersonRef | null;
  clients?: ClientRef[];
  actions?: ActionPayload[];
  statusHistories?: StatusHistoryPayload[];
  ownerHistories?: OwnerHistoryPayload[];
  satisfactionSurveyResponses?: SurveyResponsePayload[];
}

/** Display text of each canonical status (the text varies per account; baseStatus doesn't). */
export const STATUS_TEXT: Record<BaseStatus, string> = {
  New: "New",
  InAttendance: "In progress",
  Stopped: "Waiting on customer",
  Resolved: "Resolved",
  Closed: "Closed",
  Canceled: "Canceled",
};
