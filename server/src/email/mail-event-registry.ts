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

/**
 * The onboarding guide, kept to the wording of the letter Recruitment actually sends — the five
 * steps in their order, the bracketed note about the sample resignation letter, the confirmation
 * line, and the recruitment signature block.
 *
 * Written with inline styles because mail clients drop a <style> block, and as one string per
 * paragraph so a wording change stays a one-line diff.
 *
 * Only the parts that differ per agent or per brokerage are variables. The signature is the
 * brokerage's fixed letterhead: it is deliberately literal, and Settings &rarr; Templates is where
 * it changes if the office moves or the tagline does.
 */
const RED = '#c8102e';
const ONBOARD_EMAIL_BODY: string =
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111827">'
  + `<p style="margin:0 0 12px"><strong>Dear {{ agent_name }},</strong></p>`
  + `<p style="margin:0 0 16px;color:${RED}">Welcome to {{ company_name }}! We&rsquo;re excited to have you join our team of experienced professionals. To ensure a smooth and efficient transition, we&rsquo;ve outlined a simple step-by-step onboarding process for you:</p>`

  + '<p style="margin:0 0 4px"><strong>Step 1: Submit Your Resignation Letter</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Please submit your resignation letter to your current brokerage. [please find sample resignation letter attached to this mail]</li>'
  + '<li>Send the resignation email copy to our Broker of Record {{ broker_of_record }} (<a href="mailto:{{ broker_email }}" style="color:#1d4ed8">{{ broker_email }}</a>)</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Step 2: Transfer Process Initiation</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Once we receive a copy of your resignation email, TREB Membership, and RECO registration details our Broker of Record will initiate the transfer process.</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Step 3: Transfer Confirmation &amp; Setup</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Once the transfer is completed, we will notify you immediately.</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Step 4: Providing your Basic Details</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Please provide your professional headshot.</li>'
  + '<li>Along with this, provide your PREC / SP bank account details for upcoming commission payouts to our accounts team at <a href="mailto:{{ accounts_email }}" style="color:#1d4ed8">{{ accounts_email }}</a></li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Step 5: Business Cards</strong></p>'
  + '<ul style="margin:0 0 16px;padding-left:22px">'
  + '<li>Please have a look at the attached sample headshots &amp; kindly indicate your style-preference &mdash; you will be issued your personalized business cards accordingly.</li>'
  + '</ul>'

  + '<p style="margin:0 0 12px">Should you have any further questions during this process, feel free to reach out. We&rsquo;re here to support you every step of the way and look forward to your success with {{ company_name }}.</p>'
  // The count is a variable, not the literal "4" of the original letter: the documents live on the
  // template and an office that adds or removes one must not be left asking the agent to confirm a
  // number of files that were never sent. It renders empty below two, so the sentence still reads.
  + '<p style="margin:0 0 12px"><em>Kindly confirm having received this onboarding email, along with the {{ attachment_count }} attached documents.</em></p>'
  + '<p style="margin:0 0 16px">Thank you again for choosing us as your new brokerage!</p>'

  + '<p style="margin:0;color:#6b7280">--</p>'
  + `<p style="margin:0 0 14px">Appreciatively,<br><strong style="color:${RED}">Department of Recruitment</strong></p>`

  // Logo beside the details, divided by the rule, as the letter has it. A table because it is the
  // one layout primitive every mail client agrees on, and `{{ logo_img }}` rather than an <img>
  // here because the tag has to disappear entirely when no logo is uploaded — an alt-text box
  // where the brand should be is worse than a signature that starts at the rule.
  + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">'
  + '<tr>'
  + '<td style="vertical-align:middle;padding:0 18px 0 0">{{ logo_img }}</td>'
  + '<td style="vertical-align:middle;border-left:3px solid #1f3b73;padding:0 0 0 14px;font-size:12.5px;line-height:1.55;color:#111827">'
  + '<p style="margin:0"><strong>O:</strong>(905) 565-9933</p>'
  + '<p style="margin:0"><strong>E:</strong> <a href="mailto:Recruitment@GetHomeRealty.ca" style="color:#1d4ed8">Recruitment@GetHomeRealty.ca</a></p>'
  + '<p style="margin:0 0 10px"><strong>A:</strong> #405-218 Export Blvd, Mississauga ON L6R 0M8 CANADA</p>'
  + '<p style="margin:0"><strong>Get Home Realty Inc., Brokerage &ndash; &ldquo;A Tradition of Trust&rdquo;</strong></p>'
  + '<p style="margin:0 0 10px"><em>Canada&rsquo;s Leading Independent Brokerage - Celebrating 10 years of success</em></p>'
  + '<p style="margin:0 0 8px"><strong>Best Commission Split&nbsp; |&nbsp; Low Fees&nbsp; |&nbsp; Superior Support</strong></p>'
  + '<p style="margin:0"><a href="https://www.gethomerealty.ca" style="color:#1d4ed8"><strong>www.gethomerealty.ca</strong></a></p>'
  + '</td>'
  + '</tr>'
  + '</table>'
  + '</div>';

/**
 * The Independent Contractor Agreement, in the wording of the signed document, with the agent's own
 * particulars filled in — name, address, agent type, and the commission structure recorded on their
 * profile. It is the agreement itself rather than a covering note about one, so what the agent is
 * asked to sign can be read and corrected before it is sent.
 *
 * Only the two commission lines differ between the versions in circulation (a flat split, or the
 * tiered "first N deals" one, each optionally with a brokerage-lead split), so they arrive as
 * `{{ commission_terms }}` built from the agent's record. Everything else is the same in every copy
 * and is written out here.
 *
 * Blanks stay blank: a detail missing from the profile renders as a ruled line, exactly as the paper
 * form does, rather than as an empty gap that reads as though the term does not apply.
 */
const CONTRACT_AGREEMENT_BODY: string =
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13.5px;line-height:1.6;color:#111827">'
  + `<p style="margin:0 0 16px;text-align:center;font-size:18px;font-weight:700;color:${RED};letter-spacing:.3px">INDEPENDENT CONTRACTOR AGREEMENT</p>`
  + '<p style="margin:0 0 12px">This Agreement is entered into on {{ agreement_day }} day of {{ agreement_month }}, {{ agreement_year }} by and between:</p>'
  + '<p style="margin:0 0 8px">1. <strong>{{ company_name }} BROKERAGE</strong> (the &lsquo;Brokerage&rsquo;), having an office at {{ company_address }}.</p>'
  + '<p style="margin:0 0 8px">2. <strong>{{ agent_name }}</strong> [Agent&rsquo;s Full Name], residing at {{ agent_address }} [Agent&rsquo;s Address]</p>'
  + '<p style="margin:0 0 14px"><strong>Agent Type:</strong> {{ agent_type }}</p>'

  + '<p style="margin:0 0 4px"><strong>Key Terms:</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>This is an independent contractor relationship. Agent is responsible for all taxes and no employee benefits provided.</li>'
  + '<li>Agent to comply with RECO, REBBA 2002, and Brokerage policies.</li>'
  + '<li>Agent to conduct all business under the Brokerage name and covers personal expenses unless otherwise agreed.</li>'
  + '<li>Brokerage Provides Agent Marketing Materials &amp; Video Services, and a $299 Sale Listing Media Fee covering photography, walkthrough video and a virtual tour. This fee will be deducted from the agent&rsquo;s commission upon closing the transaction (either).</li>'
  + '<li>Brokerage provides access to shared office, admin support, compliance tools, trainings and optional leads.</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Commission Structure:</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '{{ commission_terms }}'
  + '<li>Minimum Brokerage Commission: $499+HST (Sale Listing), $250+HST (Lease Listing), $200+HST (Buy/Lease).</li>'
  + '<li>Agent is entitled to 1000 Free Business Cards on Joining.</li>'
  + '<li>No Monthly or Annual Brokerage Fee. (any future changes, if applicable, will be communicated in advance).</li>'
  + '<li>Commissions subject to HST and documentation compliance.</li>'
  + '</ul>'

  + '<p style="margin:0 0 2px">Other Remarks: <span style="color:#9ca3af">______________________________________________________________</span></p>'
  + `<p style="margin:0 0 14px;font-size:12px;font-style:italic;color:${RED}">Any further changes or updates in rules, policies, or implementations will be communicated to agents directly by the brokerage through official emails or other authorized communication channels.</p>`

  + '<p style="margin:0 0 4px"><strong>Termination:</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Either party may terminate the agreement Immediately with cause.</li>'
  + '<li>Immediate termination possible for cause (e.g., license suspension, ethics breach).</li>'
  + '<li>All brokerage property must be returned upon termination.</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Non-Solicitation &amp; Confidentiality:</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Agent must not solicit clients or recruit staff for 6 months post-termination.</li>'
  + '<li>Any Confidential information must not be disclosed for 6 months post-termination.</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Legal &amp; Administrative:</strong></p>'
  + '<ul style="margin:0 0 16px;padding-left:22px">'
  + '<li>Disputes resolved under Ontario Arbitration Act, 1991.</li>'
  + '<li>Governed by Ontario laws.</li>'
  + '<li>Agreement supersedes prior understandings.</li>'
  + '</ul>'

  + '<p style="margin:0 0 12px">IN WITNESS WHEREOF, the parties have executed this Agreement on the date first written above.</p>'

  // Signature blocks side by side, as they are on the page. A table because a mail client will not
  // hold two columns any other way.
  + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;font-size:12.5px">'
  + '<tr>'
  + '<td style="width:50%;vertical-align:top;border:1px solid #d1d5db;padding:10px 12px">'
  + '<p style="margin:0 0 10px"><strong>{{ company_name }} BROKERAGE</strong></p>'
  + '<p style="margin:0 0 10px">Signature: <span style="color:#9ca3af">___________________________</span></p>'
  + '<p style="margin:0 0 10px">Name: Sai Venkata Ramesh Gollu (<em>Broker Manager</em>)</p>'
  + '<p style="margin:0">Date: <span style="color:#9ca3af">_____________________</span></p>'
  + '</td>'
  + '<td style="width:50%;vertical-align:top;border:1px solid #d1d5db;padding:10px 12px">'
  + '<p style="margin:0 0 10px"><strong>AGENT</strong></p>'
  + '<p style="margin:0 0 10px">Signature: <span style="color:#9ca3af">___________________________</span></p>'
  + '<p style="margin:0 0 10px">Name: {{ agent_name }}</p>'
  + '<p style="margin:0">Date: <span style="color:#9ca3af">_____________________</span></p>'
  + '</td>'
  + '</tr>'
  + '</table>'
  + '</div>';

export const MAIL_EVENTS: Record<string, MailEvent> = {
  'user.onboard_email': {
    module: 'Onboarding',
    label: 'Agent — Onboarding Guide',
    variables: ['agent_name', 'agent_email', 'company_name', 'broker_of_record', 'broker_email', 'accounts_email', 'attachment_count', 'logo_img', 'onboard_date', 'current_date'],
    default_subject: 'Welcome, {{ agent_name }}! Here’s your onboarding guide to {{ company_name }}',
    default_body_html: ONBOARD_EMAIL_BODY,
  },
  'user.contract_agreement': {
    module: 'Onboarding',
    label: 'Agent — Contract Agreement',
    variables: ['agent_name', 'agent_email', 'agent_address', 'agent_type', 'company_name', 'company_address', 'commission_terms', 'agreement_day', 'agreement_month', 'agreement_year', 'broker_of_record', 'contract_date', 'onboard_date', 'current_date'],
    default_subject: 'Your Independent Contractor Agreement with {{ company_name }}',
    default_body_html: CONTRACT_AGREEMENT_BODY,
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
  /**
   * The outcome of an administrator's review of an agent's change. Editable in
   * Settings → Templates → Transactions like any other event.
   */
  'transaction.review_decision': {
    module: 'Transactions',
    label: 'Transactions — Review Decision',
    variables: ['agent_name', 'deal_number', 'property_address', 'decision', 'field_label', 'old_value', 'new_value', 'reason', 'reviewer', 'decided_at', 'revert_note', 'transaction_button', 'company_name', 'current_date'],
    default_subject: '{{ decision }}: {{ field_label }} — {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>Hello {{ agent_name }},</p>'
      + '<p>Your change on <strong>{{ property_address }}</strong> ({{ deal_number }}) has been <strong>{{ decision }}</strong> by {{ reviewer }}.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Field</td><td style="padding:4px 0;font-weight:600">{{ field_label }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Was</td><td style="padding:4px 0">{{ old_value }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Changed to</td><td style="padding:4px 0;font-weight:600">{{ new_value }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Decision</td><td style="padding:4px 0;font-weight:600">{{ decision }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Reason</td><td style="padding:4px 0">{{ reason }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Reviewed by</td><td style="padding:4px 0">{{ reviewer }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">When</td><td style="padding:4px 0">{{ decided_at }}</td></tr>'
      + '</table>'
      + '<p style="color:#4b5563">{{ revert_note }}</p>'
      + '{{ transaction_button }}'
      + '<p>You can reply on the transaction’s chat — the whole team sees the conversation there.</p>'
      + '<p>Regards,<br>{{ company_name }}</p>',
  },
  /** Chases an agent whose rejected change is still open — a day, three days, a week. */
  'transaction.review_reminder': {
    module: 'Transactions',
    label: 'Transactions — Review Reminder',
    variables: ['agent_name', 'deal_number', 'property_address', 'field_label', 'reason', 'reviewer', 'open_for', 'rejected_at', 'transaction_button', 'company_name', 'current_date'],
    default_subject: 'Still outstanding: {{ field_label }} — {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>Hello {{ agent_name }},</p>'
      + '<p>A change on <strong>{{ property_address }}</strong> ({{ deal_number }}) was rejected {{ open_for }} ago and is still outstanding.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Field</td><td style="padding:4px 0;font-weight:600">{{ field_label }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Reason</td><td style="padding:4px 0">{{ reason }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Rejected</td><td style="padding:4px 0">{{ rejected_at }} by {{ reviewer }}</td></tr>'
      + '</table>'
      + '<p>Correcting the field on the transaction is what closes this — the office is notified automatically once you do.</p>'
      + '{{ transaction_button }}'
      + '<p>Regards,<br>{{ company_name }}</p>',
  },
  /** The same item, to the office, once it has been open a week. */
  'transaction.review_escalation': {
    module: 'Transactions',
    label: 'Transactions — Review Escalation',
    variables: ['agent_name', 'deal_number', 'property_address', 'field_label', 'reason', 'reviewer', 'open_for', 'rejected_at', 'transaction_button', 'company_name', 'current_date'],
    default_subject: 'Escalation: {{ field_label }} open {{ open_for }} — {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>A rejected change has been outstanding for {{ open_for }} and the agent has not corrected it.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Deal</td><td style="padding:4px 0;font-weight:600">{{ deal_number }} — {{ property_address }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Agent</td><td style="padding:4px 0;font-weight:600">{{ agent_name }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Field</td><td style="padding:4px 0;font-weight:600">{{ field_label }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Reason given</td><td style="padding:4px 0">{{ reason }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Rejected</td><td style="padding:4px 0">{{ rejected_at }} by {{ reviewer }}</td></tr>'
      + '</table>'
      + '{{ transaction_button }}'
      + '<p>{{ company_name }}</p>',
  },
  /** Daily countdown to a listing's expiry date, from ten days out. */
  'transaction.listing_expiry_reminder': {
    module: 'Transactions',
    label: 'Transactions — Listing Expiry Reminder',
    variables: ['agent_name', 'deal_number', 'property_address', 'listing_type', 'expiry_date', 'days_remaining', 'expiry_phrase', 'transaction_button', 'company_name', 'current_date'],
    default_subject: 'Listing {{ expiry_phrase }} — {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>Hello {{ agent_name }},</p>'
      + '<p>Your listing on <strong>{{ property_address }}</strong> <strong>{{ expiry_phrase }}</strong>.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Transaction</td><td style="padding:4px 0;font-weight:600">{{ deal_number }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Property</td><td style="padding:4px 0;font-weight:600">{{ property_address }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Listing type</td><td style="padding:4px 0">{{ listing_type }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Expiry date</td><td style="padding:4px 0;font-weight:600">{{ expiry_date }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Days remaining</td><td style="padding:4px 0;font-weight:600">{{ days_remaining }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Agent</td><td style="padding:4px 0">{{ agent_name }}</td></tr>'
      + '</table>'
      + '<p>Renew or extend the listing before the date passes — once it does, the status changes to Expired automatically.</p>'
      + '{{ transaction_button }}'
      + '<p>Regards,<br>{{ company_name }}</p>',
  },
  /** Buyer lawyer details outstanding. */
  'transaction.lawyer_buyer_reminder': {
    module: 'Transactions',
    label: 'Transactions — Buyer Lawyer Reminder',
    variables: ['agent_name', 'deal_number', 'property_address', 'closing_date', 'days_remaining', 'closing_phrase', 'missing_details', 'transaction_button', 'company_name', 'current_date'],
    default_subject: 'Buyer Lawyer Details Required — {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>Hello {{ agent_name }},</p>'
      + '<p>Please upload the Buyer Lawyer Details for Transaction <strong>{{ deal_number }}</strong>.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Transaction</td><td style="padding:4px 0;font-weight:600">{{ deal_number }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Property</td><td style="padding:4px 0;font-weight:600">{{ property_address }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Closing date</td><td style="padding:4px 0;font-weight:600">{{ closing_date }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Time remaining</td><td style="padding:4px 0;font-weight:600">{{ closing_phrase }} ({{ days_remaining }} days)</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Still needed</td><td style="padding:4px 0;font-weight:600">{{ missing_details }}</td></tr>'
      + '</table>'
      + '{{ transaction_button }}'
      + '<p>Regards,<br>{{ company_name }}</p>',
  },
  /** Seller lawyer details outstanding. */
  'transaction.lawyer_seller_reminder': {
    module: 'Transactions',
    label: 'Transactions — Seller Lawyer Reminder',
    variables: ['agent_name', 'deal_number', 'property_address', 'closing_date', 'days_remaining', 'closing_phrase', 'missing_details', 'transaction_button', 'company_name', 'current_date'],
    default_subject: 'Seller Lawyer Details Required — {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>Hello {{ agent_name }},</p>'
      + '<p>Please upload the Seller Lawyer Details for Transaction <strong>{{ deal_number }}</strong>.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Transaction</td><td style="padding:4px 0;font-weight:600">{{ deal_number }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Property</td><td style="padding:4px 0;font-weight:600">{{ property_address }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Closing date</td><td style="padding:4px 0;font-weight:600">{{ closing_date }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Time remaining</td><td style="padding:4px 0;font-weight:600">{{ closing_phrase }} ({{ days_remaining }} days)</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Still needed</td><td style="padding:4px 0;font-weight:600">{{ missing_details }}</td></tr>'
      + '</table>'
      + '{{ transaction_button }}'
      + '<p>Regards,<br>{{ company_name }}</p>',
  },
  /** Both sides outstanding. */
  'transaction.lawyer_both_reminder': {
    module: 'Transactions',
    label: 'Transactions — Buyer & Seller Lawyer Reminder',
    variables: ['agent_name', 'deal_number', 'property_address', 'closing_date', 'days_remaining', 'closing_phrase', 'missing_details', 'transaction_button', 'company_name', 'current_date'],
    default_subject: 'Buyer & Seller Lawyer Details Required — {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>Hello {{ agent_name }},</p>'
      + '<p>Please upload both the Buyer Lawyer Details and the Seller Lawyer Details for Transaction <strong>{{ deal_number }}</strong>.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Transaction</td><td style="padding:4px 0;font-weight:600">{{ deal_number }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Property</td><td style="padding:4px 0;font-weight:600">{{ property_address }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Closing date</td><td style="padding:4px 0;font-weight:600">{{ closing_date }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Time remaining</td><td style="padding:4px 0;font-weight:600">{{ closing_phrase }} ({{ days_remaining }} days)</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Still needed</td><td style="padding:4px 0;font-weight:600">{{ missing_details }}</td></tr>'
      + '</table>'
      + '{{ transaction_button }}'
      + '<p>Regards,<br>{{ company_name }}</p>',
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
  /**
   * The outcome of a document review, sent to the agent when an administrator saves their
   * verification. `documents_table` carries the result of every document — the ones that passed
   * first, then the ones that did not with the reason each was rejected for.
   */
  'document.review_result': {
    module: 'Documents',
    label: 'Documents — Review Outcome',
    variables: ['agent_name', 'deal_number', 'property_address', 'valid_count', 'invalid_count', 'documents_table', 'instructions', 'company_name', 'current_date'],
    default_subject: 'Document review — {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p>Hello {{ agent_name }},</p>'
      + '<p>Your documents for <strong>{{ property_address }}</strong> ({{ deal_number }}) have been reviewed.</p>'
      + '{{ documents_table }}'
      + '<p>{{ instructions }}</p>'
      + '<p>Regards,<br>{{ company_name }}</p>',
  },
  /**
   * Sent the moment an agent uploads a document, with the file itself attached, so the deals desk
   * has the paperwork without having to open the transaction to find it.
   */
  'document.agent_upload': {
    module: 'Documents',
    label: 'Documents — Agent Upload Notice',
    variables: ['agent_name', 'deal_number', 'property_address', 'document_name', 'file_name', 'company_name', 'current_date'],
    default_subject: 'Document uploaded — {{ document_name }} · {{ property_address }} ({{ deal_number }})',
    default_body_html:
      '<p><strong>{{ agent_name }}</strong> uploaded a document to {{ deal_number }}.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:3px 14px 3px 0;color:#6b7280">Deal</td><td style="padding:3px 0;font-weight:600">{{ deal_number }}</td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#6b7280">Property</td><td style="padding:3px 0;font-weight:600">{{ property_address }}</td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#6b7280">Document</td><td style="padding:3px 0;font-weight:600">{{ document_name }}</td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#6b7280">File</td><td style="padding:3px 0;font-weight:600">{{ file_name }}</td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#6b7280">Uploaded by</td><td style="padding:3px 0;font-weight:600">{{ agent_name }}</td></tr>'
      + '</table>'
      + '<p>The file is attached to this email.</p>'
      + '<p>{{ company_name }}</p>',
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

/**
 * SHA-256 of template bodies this app shipped in the past.
 *
 * A row still holding one of these has never had its wording edited by anyone, so a correction to
 * the shipped text can safely replace it. `updated_at` cannot answer that question on its own: it
 * also moves when a template is merely switched on or given a sender, which was enough to freeze the
 * contract agreement on superseded wording with nobody having touched a word of it.
 *
 * Add an entry whenever a `default_body_html` above is rewritten, so the version being replaced stays
 * recognisable in databases that have not seen the new one yet.
 */
export const SUPERSEDED_BODY_HASHES: Record<string, string[]> = {
  // The paraphrase of the recruitment letter, shipped until 2026-07-30, when the letter's own
  // wording, signature block and logo replaced it.
  'user.onboard_email': ['2e89930be4e11d4fdb33552fdec7b0894b18eda3359ac68b01e88cff17a04c3e'],
  // The covering note that referred to an attached agreement, shipped until 2026-07-30, when the
  // agreement itself — filled in from the agent's profile — replaced it.
  'user.contract_agreement': ['152ec34e4ebccf846b57799efb8ebcf34b78f2a6d53f56c1331536a1bda6b767'],
};

export const variablesFor = (key: string): string[] => MAIL_EVENTS[key]?.variables ?? [];

/** Plain, safe {{ variable }} substitution — no eval. Unknown tokens → empty string. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== null && vars[key] !== undefined ? String(vars[key]) : '',
  );
}
