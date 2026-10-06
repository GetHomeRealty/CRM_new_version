import api from './axios';
import type {
  AgentCreated, CandidateDetail, CandidateDocument, CandidateList, CandidateNote, CandidateStatus,
  Followup, Interview, InterviewList, InterviewStatus, OnboardingItem, PendingFollowups, Recommendation,
  RecruitmentMessage, RecruitmentPerson, RecruitmentStats, SmsComposer,
} from '../types/recruitment';

/**
 * Recruitment & Interview.
 *
 * Nothing here decides anything. The server checks `recruitment: view/edit` for the screens and
 * `recruitment.decide` for approval and account creation, and it checks them whether or not this
 * file was involved — hiding a button is a courtesy to the person using the screen, never a
 * control. Every call below can be made by hand and will be refused on its merits.
 */

/**
 * Who a candidate may be assigned to. Needs `recruitment: view`, which is why this is not
 * `/api/leads/options` — that returns the same shape behind `lead: view`, which a recruiter has
 * no business holding.
 */
export const recruitmentPeople = (): Promise<{ data: RecruitmentPerson[] }> =>
  api.get<{ data: RecruitmentPerson[] }>('/api/recruitment/people').then((r) => r.data);

export const recruitmentStats = (): Promise<RecruitmentStats> =>
  api.get<RecruitmentStats>('/api/recruitment/stats').then((r) => r.data);

/** `recruiter` is a user id or `none`; `source` a stored value or `__none__` — the keys Reports gives. */
export const listCandidates = (
  params: { status?: string; q?: string; recruiter?: string; source?: string; page?: number; perPage?: number } = {},
): Promise<CandidateList> =>
  api.get<CandidateList>('/api/recruitment/candidates', {
    params: {
      status: params.status || undefined, q: params.q || undefined,
      recruiter: params.recruiter || undefined, source: params.source || undefined,
      page: params.page && params.page > 1 ? params.page : undefined,
      // Server default is 50 and it caps at 200; only sent when a page size was asked for.
      per_page: params.perPage || undefined,
    },
  }).then((r) => r.data);

/** Interviews across the candidates you may see, optionally one status — the list the interview cards open. */
export const listInterviews = (status?: string): Promise<InterviewList> =>
  api.get<InterviewList>('/api/recruitment/interviews', { params: { status: status || undefined } }).then((r) => r.data);

export const getCandidate = (id: number): Promise<CandidateDetail> =>
  api.get<CandidateDetail>(`/api/recruitment/candidates/${id}`).then((r) => r.data);

/**
 * An agent's "Refer a Candidate". Submission only: the answer is a confirmation sentence, never the
 * record — agents cannot read recruitment, and the server takes the referring agent from the session.
 */
export const referCandidate = (body: { name: string; phone: string; email?: string; note?: string }): Promise<{ message: string }> =>
  api.post<{ message: string }>('/api/recruitment/referrals', body).then((r) => r.data);

export const createCandidate = (body: Record<string, unknown>): Promise<{ data: CandidateDetail['candidate'] }> =>
  api.post('/api/recruitment/candidates', body).then((r) => r.data);

export const updateCandidate = (id: number, body: Record<string, unknown>): Promise<{ data: CandidateDetail['candidate'] }> =>
  api.put(`/api/recruitment/candidates/${id}`, body).then((r) => r.data);

export const assignRecruiter = (id: number, recruiterId: number | null): Promise<{ data: CandidateDetail['candidate'] }> =>
  api.post(`/api/recruitment/candidates/${id}/assign`, { recruiter_id: recruiterId }).then((r) => r.data);

/** Moves the CANDIDATE. Approved, Onboarding and Active need `recruitment.decide` on the server. */
export const setCandidateStatus = (id: number, status: CandidateStatus): Promise<{ data: CandidateDetail['candidate'] }> =>
  api.post(`/api/recruitment/candidates/${id}/status`, { status }).then((r) => r.data);

export const archiveCandidate = (id: number): Promise<{ message: string }> =>
  api.delete(`/api/recruitment/candidates/${id}`).then((r) => r.data);

export const scheduleInterview = (id: number, body: Record<string, unknown>): Promise<{ data: Interview }> =>
  api.post(`/api/recruitment/candidates/${id}/interviews`, body).then((r) => r.data);

/** Reschedules, records feedback, or sets the INTERVIEW's outcome — never the candidate's status. */
export const updateInterview = (
  id: number, interviewId: number, body: Partial<{ scheduled_at: string; interviewer_id: number; feedback: string; status: InterviewStatus; mode: string; location: string }>,
): Promise<{ data: Interview }> =>
  api.put(`/api/recruitment/candidates/${id}/interviews/${interviewId}`, body).then((r) => r.data);

/** The recruiter's advice. Recorded as advice; an administrator still has to decide. */
export const recommendCandidate = (id: number, recommendation: Recommendation): Promise<{ data: CandidateDetail['candidate'] }> =>
  api.post(`/api/recruitment/candidates/${id}/recommend`, { recommendation }).then((r) => r.data);

export const addCandidateNote = (id: number, body: string): Promise<{ data: CandidateNote }> =>
  api.post(`/api/recruitment/candidates/${id}/notes`, { body }).then((r) => r.data);

export const addFollowup = (id: number, body: { title: string; due_at: string }): Promise<{ data: Followup }> =>
  api.post(`/api/recruitment/candidates/${id}/followups`, body).then((r) => r.data);

export const completeFollowup = (id: number, followupId: number): Promise<{ data: Followup }> =>
  api.post(`/api/recruitment/candidates/${id}/followups/${followupId}/done`).then((r) => r.data);

export const pendingFollowups = (): Promise<PendingFollowups> =>
  api.get<PendingFollowups>('/api/recruitment/followups').then((r) => r.data);

export const requestDocument = (id: number, name: string): Promise<{ data: CandidateDocument }> =>
  api.post(`/api/recruitment/candidates/${id}/documents`, { name }).then((r) => r.data);

export const receiveDocument = (
  id: number, documentId: number, body: { file_name?: string; file_path?: string },
): Promise<{ data: CandidateDocument }> =>
  api.post(`/api/recruitment/candidates/${id}/documents/${documentId}/received`, body).then((r) => r.data);

export const addOnboardingItem = (id: number, title: string): Promise<{ data: OnboardingItem }> =>
  api.post(`/api/recruitment/candidates/${id}/onboarding`, { title }).then((r) => r.data);

export const completeOnboardingItem = (id: number, itemId: number): Promise<{ data: OnboardingItem }> =>
  api.post(`/api/recruitment/candidates/${id}/onboarding/${itemId}/done`).then((r) => r.data);

/**
 * Creates a user who can sign in. Irreversible, which is why the screen confirms first — and why
 * the server checks `recruitment.decide` inside the transaction rather than trusting that it did.
 */
/**
 * The administrator supplies the first password and confirms it, exactly as on the Users screen.
 * The server re-checks both against the shared policy; the checks in the form are only there to
 * answer sooner.
 */
/**
 * The composer's opening state. The number comes from the SERVER, read off the candidate — the
 * screen never tells the server where to send, it is only shown where the server would send.
 */
export const smsComposer = (id: number): Promise<SmsComposer> =>
  api.get<SmsComposer>(`/api/recruitment/candidates/${id}/sms`).then((r) => r.data);

export const sendCandidateSms = (id: number, body: string): Promise<{ data: RecruitmentMessage }> =>
  api.post<{ data: RecruitmentMessage }>(`/api/recruitment/candidates/${id}/sms`, { body }).then((r) => r.data);

/** Record whether the candidate agreed to be texted. `true` or `false` — never cleared back to null. */
export const setSmsConsent = (id: number, consent: boolean, note?: string): Promise<{ data: unknown }> =>
  api.post<{ data: unknown }>(`/api/recruitment/candidates/${id}/sms-consent`, { consent, note }).then((r) => r.data);

export const candidateMessages = (id: number): Promise<{ data: RecruitmentMessage[] }> =>
  api.get<{ data: RecruitmentMessage[] }>(`/api/recruitment/candidates/${id}/messages`).then((r) => r.data);

export const createAgentAccount = (
  id: number,
  body: { password: string; password_confirmation: string; role?: string; username?: string },
): Promise<AgentCreated> =>
  api.post<AgentCreated>(`/api/recruitment/candidates/${id}/agent`, body).then((r) => r.data);
