/**
 * Recruitment & Interview.
 *
 * CANDIDATE STATUS AND INTERVIEW STATUS ARE DIFFERENT TYPES, not one union used twice. They share
 * three words — approved, hold, not_selected — and that overlap is exactly why they must not share
 * a type: an interview's outcome is what the interviewer concluded, and a candidate's status is
 * where the brokerage has got to with the person. Keeping them apart means the compiler refuses the
 * confusion rather than leaving it to a reviewer.
 */

export const CANDIDATE_STATUSES = [
  'new', 'contacted', 'interview', 'approved', 'onboarding', 'active', 'hold', 'not_selected',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * `cancelled` is not an outcome — the other four all describe an interview that HAPPENED. It exists
 * so an interview can be called off, which also stops its reminders: the sweep selects only
 * `scheduled`. Mirrors `server/src/recruitment/recruitment.status.ts`.
 */
export const INTERVIEW_STATUSES = [
  'scheduled', 'completed', 'approved', 'hold', 'not_selected', 'cancelled',
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/** What a recruiter may recommend. Advice — it never moves the candidate. */
export const RECOMMENDATIONS = ['approved', 'hold', 'not_selected'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/** The three the brokerage uses. A CHECK constraint on the column enforces the same list. */
export const AVAILABILITY = ['full_time', 'part_time', 'flexible'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const availabilityLabel = (v: string | null | undefined): string => (
  v === 'full_time' ? 'Full time'
    : v === 'part_time' ? 'Part time'
      : v === 'flexible' ? 'Flexible'
        : 'Not asked'
);

/**
 * How a nullable yes/no reads on screen.
 *
 * NULL IS "NOT ASKED", NOT "NO". Rendering an unanswered question as "No" would put words in the
 * candidate's mouth, and somebody reading the screen later would have no way to tell a question
 * answered in the negative from one nobody got round to.
 */
export const yesNoUnknown = (v: boolean | null | undefined): string => (
  v === true ? 'Yes' : v === false ? 'No' : 'Not asked'
);

/** Somebody a candidate can be assigned to. From `/api/recruitment/people`, active users only. */
export interface RecruitmentPerson {
  id: number;
  name: string;
  role: string;
}

export interface Candidate {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  location: string | null;
  source: string | null;
  referred_by_user_id: number | null;
  assigned_recruiter_id: number | null;
  status: CandidateStatus;
  recommendation: Recommendation | null;
  recommended_by_user_id: number | null;
  recommended_at: string | null;
  approved_by_user_id: number | null;
  approved_at: string | null;
  /** Set only once an administrator created the account. Null means no account exists. */
  agent_user_id: number | null;
  activated_at: string | null;
  /*
   * Experience and licence. Every one nullable, and null means NOT ASKED rather than "no" — see
   * `yesNoUnknown`, which is how the screen says the difference.
   */
  /** Recorded, never assumed. Null means nobody has asked — see `SmsConsent`. */
  sms_consent: boolean | null;
  sms_consent_at: string | null;
  sms_consent_by: string | null;
  sms_consent_note: string | null;
  has_real_estate_experience: boolean | null;
  years_experience: number | null;
  is_licensed: boolean | null;
  licence_number: string | null;
  /** Current when licensed, previous when not. Which it is follows from `is_licensed`. */
  brokerage_name: string | null;
  availability: Availability | string | null;
  training_needs: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  /*
   * Resolved by the server, so the screen never holds a user directory just to draw a label.
   * Null means genuinely nobody — which the screen says as "Unassigned", never as a fabricated name.
   */
  assigned_recruiter_name?: string | null;
  recommended_by_name?: string | null;
  approved_by_name?: string | null;
  referred_by_name?: string | null;
  agent_user_name?: string | null;
}

/** One row of the Interviews list: an interview with the candidate it belongs to. */
export interface InterviewRow {
  id: number;
  status: InterviewStatus;
  scheduled_at: string | null;
  mode: string | null;
  location: string | null;
  interviewer_name: string | null;
  candidate: { id: number; name: string; status: CandidateStatus };
}

export interface InterviewList {
  total: number;
  data: InterviewRow[];
}

export interface Interview {
  id: number;
  candidate_id: number;
  interviewer_id: number | null;
  scheduled_at: string | null;
  status: InterviewStatus;
  mode: string | null;
  location: string | null;
  feedback: string | null;
  created_by: string | null;
  created_at: string | null;
  interviewer_name?: string | null;
}

export interface CandidateNote {
  id: number;
  candidate_id: number;
  body: string;
  author: string | null;
  created_at: string | null;
}

export interface Followup {
  id: number;
  candidate_id: number;
  title: string;
  due_at: string;
  done_at: string | null;
  assigned_to: number | null;
  created_by: string | null;
  assigned_to_name?: string | null;
}

/** `file_path` null and `requested_at` set means it was asked for and has not arrived. */
export interface CandidateDocument {
  id: number;
  candidate_id: number;
  name: string;
  file_path: string | null;
  file_name: string | null;
  requested_at: string | null;
  uploaded_at: string | null;
  uploaded_by: string | null;
}

export interface OnboardingItem {
  id: number;
  candidate_id: number;
  title: string;
  position: number;
  done_at: string | null;
  done_by: string | null;
}

export interface RecruitmentEvent {
  id: number;
  candidate_id: number;
  action: string;
  detail: string | null;
  actor_name: string | null;
  created_at: string | null;
}

export interface CandidateDetail {
  candidate: Candidate;
  interviews: Interview[];
  notes: CandidateNote[];
  followups: Followup[];
  documents: CandidateDocument[];
  onboarding: OnboardingItem[];
  events: RecruitmentEvent[];
}

export interface CandidateList {
  data: Candidate[];
  /** Every candidate the filters match — the figure a card or Reports row shows. */
  total: number;
  page: number;
  per_page: number;
  last_page: number;
}

export interface RecruitmentStats {
  total: number;
  candidates: Record<CandidateStatus, number>;
  interviews: Record<InterviewStatus, number>;
  /** `key` is the Candidates `recruiter` filter that shows exactly this row: a user id, or `none`. */
  by_recruiter: { recruiter_id: number | null; key: string; name: string; count: number }[];
  /** `key` is the Candidates `source` filter for this row; `__none__` is Not recorded (null or empty). */
  by_source: { source: string; key: string; count: number }[];
  followups_overdue: number;
}

/** The delivery record for one text sent to a candidate. */
export interface RecruitmentMessage {
  id: number;
  candidate_id: number;
  /** queued | sent | delivered | failed. Never `read` — plain SMS has no read receipt. */
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  provider_sid: string | null;
  error_code: string | null;
  error_message: string | null;
  body: string;
  /** Where it actually went, in E.164, as it stood when it was sent. */
  phone: string;
  sent_at: string;
  created_by: string | null;
  user_id: number | null;
}

/**
 * The recorded answer to "may we text you?".
 *
 * `answer` has THREE states and the screen must keep them apart: null is nobody asked, false is
 * they said no, true is they agreed. Rendering null as "No" would claim an answer nobody gave.
 */
export interface SmsConsent {
  answer: boolean | null;
  at: string | null;
  by: string | null;
  note: string | null;
}

/** What the Send Text composer opens with. */
export interface SmsComposer {
  candidate: { id: number; name: string; phone: string | null };
  /** E.164, exactly what would be dialled. Null when there is nothing dialable. */
  to: string | null;
  can_send: boolean;
  /** Why Send is disabled, in words. Null when it is not. */
  blocked_reason: string | null;
  consent: SmsConsent;
  template: string;
  gateway_configured: boolean;
}

export interface PendingFollowups {
  data: (Followup & { candidate: { id: number; name: string; status: CandidateStatus } })[];
  overdue: number;
  pending: number;
}

/**
 * What the server returns after creating an account.
 *
 * NO PASSWORD FIELD, deliberately. The administrator typed it, so they have it; sending it back
 * would put the plaintext of a working account into a response, the browser's memory and anything
 * between. The account itself holds only a hash.
 */
export interface AgentCreated {
  candidate: Candidate;
  user: { id: number; name: string; email: string; role: string };
}
