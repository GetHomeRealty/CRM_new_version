/** A single uploaded file within a multi/per-client document. */
export interface DeskDocFile { index: number; client_name?: string; file_name?: string; }

/** A Legal & Documentation checklist row. */
export interface DeskDocument {
  id?: number;
  title?: string;
  status?: string;
  validation?: string;
  drive_uploaded?: string | null;
  reminder?: boolean;
  agent_accepted?: string | null;
  remarks?: string;
  mandatory?: boolean;
  manual?: boolean;
  has_file?: boolean;
  kind?: string;
  files?: DeskDocFile[];
  file_count?: number;
  is_condition?: boolean;
  deadline?: string | null;
  has_validation_file?: boolean;
  validation_file_name?: string;
  deleted_by?: string;
  [key: string]: unknown;
}

/** Per-client FINTRAC identity (GET/PUT /api/transactions/{id}/identifications). */
export interface ClientIdentification {
  source?: string | null;
  verified?: boolean;
  full_legal_name?: string | null;
  address?: string | null;
  dob?: string | null;
  occupation?: string | null;
  id_type?: string | null;
  id_number?: string | null;
  issuing_jurisdiction?: string | null;
  country?: string | null;
  expiry_date?: string | null;
}

/** GET /api/transactions/{id}/documents response (clients are name strings). */
export interface DocumentsResponse {
  documents?: DeskDocument[];
  clients?: string[];
  deleted_documents?: DeskDocument[];
  reco_audit_ready?: string;
  reco_audit_remarks?: string;
  [key: string]: unknown;
}
