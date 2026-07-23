/** Email / SMTP settings domain types (Email Settings page). */

/** An SMTP sender account (GET /api/mail-accounts). */
export interface MailAccount {
  id: number | string;
  name: string;
  from_name?: string | null;
  from_email: string;
  host: string;
  port?: number | string;
  username?: string | null;
  encryption?: string | null;
  is_active?: boolean;
  is_default?: boolean;
  has_password?: boolean;
  [key: string]: unknown;
}

/** A configurable email template. */
export interface EmailTemplate {
  id: number | string;
  name: string;
  event_key?: string;
  module?: string;
  subject: string;
  body_html: string;
  mail_account_id?: number | string | null;
  is_active?: boolean;
  variables?: string[];
  [key: string]: unknown;
}

/** Templates grouped by module. */
export interface TemplateGroup {
  module: string;
  templates: EmailTemplate[];
}

/** GET /api/email-templates response. */
export interface EmailTemplatesResponse {
  groups?: TemplateGroup[];
  mail_accounts?: MailAccount[] | { data?: MailAccount[] };
}

/** POST /api/email-templates/:id/preview response. */
export interface TemplatePreview {
  subject?: string;
  html?: string;
}

/** POST /api/mail-accounts/:id/test response. */
export interface TestMailResult {
  message?: string;
}
