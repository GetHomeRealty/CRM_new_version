/**
 * Catalog of every email event the app can send (port of App\Mail\MailEventRegistry).
 * event_key => { module, label, variables[], default_subject, default_body_html }.
 * Variables are referenced in templates as {{ variable_name }}.
 */
export interface MailEvent {
  module: string;
  label: string;
  variables: string[];
  default_subject: string;
  default_body_html: string;
}

export const MAIL_EVENTS: Record<string, MailEvent> = {
  'invoice.send': {
    module: 'Invoice',
    label: 'Invoice — Send',
    variables: ['invoice_number', 'invoice_total', 'due_date', 'customer_name', 'transaction_number', 'company_name', 'current_date'],
    default_subject: 'Invoice {{ invoice_number }} from {{ company_name }}',
    default_body_html: '<p>Dear {{ customer_name }},</p><p>Please find your invoice <strong>{{ invoice_number }}</strong> for a total of <strong>{{ invoice_total }}</strong>, due on {{ due_date }}.</p><p>Regarding transaction {{ transaction_number }}.</p><p>Regards,<br>{{ company_name }}</p>',
  },
  'invoice.reminder': {
    module: 'Invoice',
    label: 'Invoice — Payment Reminder',
    variables: ['invoice_number', 'invoice_total', 'due_date', 'customer_name', 'transaction_number', 'company_name', 'current_date'],
    default_subject: 'Reminder: Invoice {{ invoice_number }} is due {{ due_date }}',
    default_body_html: '<p>Dear {{ customer_name }},</p><p>This is a friendly reminder that invoice <strong>{{ invoice_number }}</strong> for <strong>{{ invoice_total }}</strong> is due on {{ due_date }}.</p><p>Regards,<br>{{ company_name }}</p>',
  },
  'invoice.overdue': {
    module: 'Invoice',
    label: 'Invoice — Overdue Notice',
    variables: ['invoice_number', 'invoice_total', 'due_date', 'customer_name', 'transaction_number', 'company_name', 'current_date'],
    default_subject: 'Overdue: Invoice {{ invoice_number }}',
    default_body_html: '<p>Dear {{ customer_name }},</p><p>Our records show invoice <strong>{{ invoice_number }}</strong> for <strong>{{ invoice_total }}</strong> was due on {{ due_date }} and remains unpaid.</p><p>Please arrange payment at your earliest convenience.</p><p>Regards,<br>{{ company_name }}</p>',
  },
  'notice_of_sale.send': {
    module: 'Notice of Sale',
    label: 'Notice of Sale — Send for Signature',
    variables: ['transaction_number', 'property_address', 'sale_price', 'closing_date', 'agent_name', 'company_name'],
    default_subject: 'Notice of Sale — {{ property_address }} ({{ transaction_number }})',
    default_body_html: '<p>Hello {{ agent_name }},</p><p>A Notice of Sale for <strong>{{ property_address }}</strong> (sale price {{ sale_price }}, closing {{ closing_date }}) is ready for your signature.</p><p>Transaction {{ transaction_number }}.</p><p>Regards,<br>{{ company_name }}</p>',
  },
  'document.pending_reminder': {
    module: 'Documents',
    label: 'Documents — Pending Reminder',
    variables: ['transaction_number', 'property_address', 'pending_docs', 'agent_name', 'company_name'],
    default_subject: 'Pending documents for {{ property_address }}',
    default_body_html: '<p>Hello {{ agent_name }},</p><p>The following documents are still pending for <strong>{{ property_address }}</strong> ({{ transaction_number }}):</p><p>{{ pending_docs }}</p><p>Please upload them at your earliest convenience.</p><p>Regards,<br>{{ company_name }}</p>',
  },
  // Drives every reminder sent from the documentation reports: one document, all pending or
  // all invalid documents in a deal, or a bulk send (one message per deal, never mixed).
  'document.reminder': {
    module: 'Documents',
    label: 'Documents — Pending / Invalid Reminder',
    variables: ['deal_number', 'property_address', 'agent_name', 'status_label', 'document_count', 'documents_table', 'instructions', 'company_name', 'current_date'],
    default_subject: '{{ status_label }} documentation for {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>Hello {{ agent_name }},</p>'
      + '<p>The following <strong>{{ document_count }}</strong> document(s) require your attention on deal <strong>{{ deal_number }}</strong> — {{ property_address }}:</p>'
      + '{{ documents_table }}'
      + '<p>{{ instructions }}</p>'
      + '<p>Regards,<br>{{ company_name }}</p>',
  },
  'deposit_receipt.send': {
    module: 'Deposit Receipt',
    label: 'Deposit Receipt — Send',
    variables: ['transaction_number', 'deposit_amount', 'property_address', 'company_name'],
    default_subject: 'Deposit Receipt — {{ property_address }}',
    default_body_html: '<p>Please find attached the deposit receipt for <strong>{{ property_address }}</strong> ({{ transaction_number }}).</p><p>Deposit amount: <strong>{{ deposit_amount }}</strong>.</p><p>Regards,<br>{{ company_name }}</p>',
  },
  'trade_sheet.send': {
    module: 'Trade Sheet',
    label: 'Trade Record Sheet — Send',
    variables: ['transaction_number', 'property_address', 'agent_name', 'company_name'],
    default_subject: 'Trade Record Sheet — {{ property_address }} ({{ transaction_number }})',
    default_body_html: '<p>Please find the Trade Record Sheet for <strong>{{ property_address }}</strong> ({{ transaction_number }}).</p><p>Agent: {{ agent_name }}.</p><p>Regards,<br>{{ company_name }}</p>',
  },
  'agent_faq.batch_review': {
    module: 'Agent FAQ',
    label: 'Agent FAQ — Batch Review Request',
    variables: ['transaction_number', 'agent_name', 'company_name'],
    default_subject: 'Client review request — {{ transaction_number }}',
    default_body_html: '<p>Hello {{ agent_name }},</p><p>Please request client reviews for transaction {{ transaction_number }}.</p><p>Regards,<br>{{ company_name }}</p>',
  },
};

export const variablesFor = (key: string): string[] => MAIL_EVENTS[key]?.variables ?? [];

/** Plain, safe {{ variable }} substitution — no eval. Unknown tokens → empty string. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== null && vars[key] !== undefined ? String(vars[key]) : '',
  );
}
