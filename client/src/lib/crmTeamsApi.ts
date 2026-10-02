import api from './axios';

/** CRM Teams API — CRM → Settings → Teams, and the team views on Leads and the dashboard. */

export interface CrmTeamMember {
  user_id: number;
  name: string;
  role: string;
  /** Still in the team. A removed member keeps their row, inactive. */
  is_active: boolean;
  /** The person's account is active. */
  user_active: boolean;
}

export interface CrmTeam {
  id: number;
  name: string;
  description: string | null;
  team_lead_user_id: number | null;
  team_lead_name: string | null;
  team_lead_active: boolean;
  is_active: boolean;
  members: CrmTeamMember[];
  lead_count: number;
  created_at: string | null;
  updated_at: string | null;
}

/** A team as a dropdown needs it: its active, assignable members only. */
export interface CrmTeamOption {
  id: number;
  name: string;
  is_active: boolean;
  team_lead_user_id: number | null;
  team_lead_name: string | null;
  members: { user_id: number; name: string }[];
}

export interface CrmTeamLookup {
  teams: CrmTeamOption[];
  /** Active teams the signed-in user leads. */
  led_team_ids: number[];
  /** Active teams the signed-in user belongs to (including the ones they lead). */
  member_team_ids: number[];
  /** May create and edit teams (Admin / Super Admin). */
  can_manage: boolean;
  /** May move leads between teams. */
  can_move_teams: boolean;
  /** Sees the brokerage's own leads. */
  sees_brokerage: boolean;
}

export interface CrmTeamDashboard {
  in_team: boolean;
  teams: { id: number; name: string }[];
  cards: { my_leads: number; my_team_leads: number; unassigned_team_leads: number; follow_ups_due: number; new_today: number };
  team_lead: {
    team_id: number; team_name: string; total: number; assigned: number; unassigned: number;
    overdue_follow_ups: number; converted: number;
  }[];
}

export interface CrmTeamReportRow {
  team_id: number;
  team_name: string;
  team_lead_name: string | null;
  is_active: boolean;
  total: number;
  assigned: number;
  unassigned: number;
  converted: number;
  conversion_rate: number;
  agents: { user_id: number; name: string; is_member: boolean; assigned: number; converted: number; conversion_rate: number }[];
}

export interface CrmTeamReport {
  teams: CrmTeamReportRow[];
  totals: { total: number; assigned: number; unassigned: number; converted: number; conversion_rate: number };
}

export interface CrmTeamActivity {
  type: 'assignment' | 'note' | 'call' | 'task';
  lead_id: number;
  lead_name: string;
  actor: string;
  summary: string;
  at: string;
}

export interface CrmTeamInput {
  name?: string;
  description?: string | null;
  team_lead_user_id?: number | null;
  is_active?: boolean;
  member_ids?: number[];
}

export const crmTeamLookup = (): Promise<CrmTeamLookup> =>
  api.get<CrmTeamLookup>('/api/crm-teams/lookup').then((r) => r.data);

export const listCrmTeams = (): Promise<CrmTeam[]> =>
  api.get<CrmTeam[]>('/api/crm-teams').then((r) => r.data);

export const createCrmTeam = (body: CrmTeamInput): Promise<CrmTeam> =>
  api.post<CrmTeam>('/api/crm-teams', body).then((r) => r.data);

export const updateCrmTeam = (id: number, body: CrmTeamInput): Promise<CrmTeam> =>
  api.put<CrmTeam>(`/api/crm-teams/${id}`, body).then((r) => r.data);

export const deleteCrmTeam = (id: number): Promise<void> =>
  api.delete(`/api/crm-teams/${id}`).then(() => undefined);

export const crmTeamDashboard = (): Promise<CrmTeamDashboard> =>
  api.get<CrmTeamDashboard>('/api/crm-teams/dashboard').then((r) => r.data);

export const crmTeamReport = (teamId?: number): Promise<CrmTeamReport> =>
  api.get<CrmTeamReport>('/api/crm-teams/report', { params: teamId ? { teamId } : {} }).then((r) => r.data);

export const crmTeamActivity = (teamId: number): Promise<CrmTeamActivity[]> =>
  api.get<CrmTeamActivity[]>(`/api/crm-teams/${teamId}/activity`).then((r) => r.data);

/** Team & Assignment on one lead. Absent keys are left as they are; `null` clears. */
export const setLeadTeamAssignment = (
  leadId: number,
  body: { team_id?: number | null; assigned_to?: number | null },
): Promise<{ team_id: number | null; team_name: string | null; assigned_to: number | null; assigned_to_name: string | null; changed: boolean }> =>
  api.put(`/api/leads/${leadId}/team-assignment`, body).then((r) => r.data);
