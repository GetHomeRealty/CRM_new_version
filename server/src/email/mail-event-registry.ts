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
  'user.onboard_email': {
    module: 'Onboarding',
    label: 'Agent — Onboarding Guide',
    variables: ['agent_name', 'agent_email', 'company_name', 'broker_of_record', 'broker_email', 'accounts_email', 'onboard_date', 'current_date'],
    default_subject: 'Welcome, {{ agent_name }}! Here’s your onboarding guide to {{ company_name }}',
    default_body_html: '<p>Dear {{ agent_name }},</p><p>Welcome to {{ company_name }}! We&rsquo;re excited to have you join our team of experienced professionals. To ensure a smooth and efficient transition, we&rsquo;ve outlined a simple step-by-step onboarding process for you:</p><h3>Step 1: Submit Your Resignation Letter</h3><ul><li>Please submit your resignation letter to your current brokerage (a sample is attached to this email).</li><li>Send the resignation email copy to our Broker of Record {{ broker_of_record }} at {{ broker_email }}.</li></ul><h3>Step 2: Transfer Process Initiation</h3><ul><li>Once we receive a copy of your resignation email, TREB Membership, and RECO registration details, our Broker of Record will initiate the transfer process.</li></ul><h3>Step 3: Transfer Confirmation &amp; Setup</h3><ul><li>Once the transfer is completed, we will notify you immediately.</li></ul><h3>Step 4: Providing Your Basic Details</h3><ul><li>Please provide your professional headshot.</li><li>Along with this, provide your PREC / SP bank account details for upcoming commission payouts to our accounts team at {{ accounts_email }}.</li></ul><h3>Step 5: Business Cards</h3><ul><li>Please have a look at the attached sample headshots and indicate your style preference &mdash; you will be issued your personalized business cards accordingly.</li></ul><p>Should you have any further questions during this process, feel free to reach out. We&rsquo;re here to support you every step of the way and look forward to your success with {{ company_name }}.</p><p><em>Kindly confirm having received this onboarding email, along with the attached documents.</em></p><p>Thank you again for choosing us as your new brokerage!</p><p>Appreciatively,<br>Department of Recruitment<br>{{ company_name }}</p>',
  },
  'user.contract_agreement': {
    module: 'Onboarding',
    label: 'Agent — Contract Agreement',
    variables: ['agent_name', 'agent_email', 'company_name', 'broker_of_record', 'contract_date', 'onboard_date', 'current_date'],
    default_subject: 'Your Independent Contractor Agreement with {{ company_name }}',
    default_body_html: '<p>Dear {{ agent_name }},</p><p>Please find attached your Independent Contractor Agreement with {{ company_name }}, dated {{ contract_date }}.</p><p>Kindly review it in full, then sign and return a copy to us. The agreement covers your commission structure, the minimum brokerage commission, termination terms, and the non-solicitation and confidentiality provisions.</p><p>If anything in it is unclear, reply to this email before signing and we will walk you through it.</p><p>Regards,<br>{{ company_name }}</p>',
  },
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
