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
/** For the one congratulatory line in the fresher letter. Dark enough to stay legible on white. */
const GREEN = '#137333';

/**
 * The brokerage's address, on every letter that does not name its own.
 *
 * This is the address Company Settings holds and the one printed on all five signed contracts. The
 * letterhead used to read #405-218 Export Blvd, L6R 0M8 — the address on the letters Recruitment had
 * been sending — and the two contradicted each other in an obvious way for anyone who received both.
 * Settled on 2026-08-14 in favour of the one the contracts carry.
 */
const BROKERAGE_ADDRESS = '#101-218 Export Blvd, Mississauga ON L5S 0A7, CANADA';

/**
 * The letterhead every letter from the brokerage ends with: the logo with the department that sent
 * it captioned underneath, and the contact block beside it.
 *
 * ONE block for all four letters, in the Accounts design, which is the one the brokerage settled on.
 * It carries no person and no job title — a signature naming an individual would have to be kept
 * current in four templates every time somebody changed desks, and the letters are from departments
 * rather than from people. The department caption and the mailbox are what differ, so those are the
 * arguments; everything else is fixed, which is the point of having one letterhead.
 */
const signature = (department: string, email: string): string =>
  '<p style="margin:0 0 14px">Yours Truly,</p>'
  // A table because it is the one layout primitive every mail client agrees on, and
  // `{{ logo_img }}` rather than an <img> because the tag has to disappear entirely when no logo is
  // uploaded — an alt-text box where the brand should be is worse than a signature without one.
  + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">'
  + '<tr>'
  + '<td style="vertical-align:middle;padding:0 18px 0 0;text-align:center">'
  + '{{ logo_img }}'
  + `<p style="margin:14px 0 0;font-size:13.5px;color:#111827">${department}</p>`
  + '</td>'
  + '<td style="vertical-align:middle;border-left:3px solid #1f3b73;padding:0 0 0 14px;font-size:12.5px;line-height:1.55;color:#111827">'
  + '<p style="margin:0 0 8px;font-style:italic">Get Home Realty Inc.</p>'
  + '<p style="margin:0"><strong>O:</strong> 905-565-9933</p>'
  + `<p style="margin:0"><strong>E:</strong> <a href="mailto:${email}" style="color:#1d4ed8">${email}</a></p>`
  + `<p style="margin:0 0 10px"><strong>A:</strong> ${BROKERAGE_ADDRESS}</p>`
  + `<p style="margin:0;font-style:italic;color:${RED}">Get Home Realty Inc., Brokerage &ndash; &ldquo;A Tradition of Trust&rdquo;</p>`
  + '<p style="margin:0 0 8px"><strong>Best Commission Split&nbsp; |&nbsp; Low Fees&nbsp; |&nbsp; Superior Support</strong></p>'
  + '<p style="margin:0"><a href="https://www.gethomerealty.ca" style="color:#1d4ed8"><strong>www.GetHomeRealty.ca</strong></a></p>'
  // Named rather than pictured: no icon artwork ships with this application, and the sent copy of
  // the accounting letter shows why it matters — its four icons arrive as four broken-image boxes.
  + '<p style="margin:8px 0 0;color:#4b5563">Facebook&nbsp; &middot;&nbsp; YouTube&nbsp; &middot;&nbsp; LinkedIn&nbsp; &middot;&nbsp; Instagram</p>'
  + '</td>'
  + '</tr>'
  + '</table>';

/**
 * The mailbox each department answers on. The only thing that changes between the four signatures,
 * so a reply lands with the people who asked for it.
 */
const RECRUITMENT_SIGNATURE = signature('Department of Recruitment', 'Recruitment@GetHomeRealty.ca');
const TRAINING_SIGNATURE = signature('Department of Training', 'training@gethomerealty.ca');
const ACCOUNTS_SIGNATURE = signature('Accounts Department', 'Commissionpayouts@gethomerealty.ca');

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

  + RECRUITMENT_SIGNATURE
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
  // Without the paper form's field labels. "[Agent's Full Name]" is there to tell someone filling in
  // a blank what belongs in it; printed after the name it is already filled with, it reads as though
  // the agreement is unsure who it is about.
  + '<p style="margin:0 0 8px">2. <strong>{{ agent_name }}</strong>, residing at {{ agent_address }}</p>'
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

/**
 * The onboarding guide for a NEWLY LICENSED agent, in the wording of the letter Recruitment sends
 * them — the other half of `ONBOARD_EMAIL_BODY`, which addresses an agent transferring in.
 *
 * They are separate templates rather than one with a condition inside it because they share almost
 * nothing: a fresher has no brokerage to resign from and no transfer to wait on, and instead has to
 * register with RECO and TREB from scratch. A single body carrying both would be edited in Settings
 * with half of it invisible.
 *
 * The registration particulars are literal — the employer number, the brokerage id, RECO's
 * registration address — because they identify the brokerage to an outside registry and are not
 * ours to interpolate from a settings row that happens to hold a display name.
 */
const ONBOARD_EMAIL_FRESHER_BODY: string =
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111827">'
  + '<p style="margin:0 0 12px"><strong>Dear {{ agent_name }},</strong></p>'
  + `<p style="margin:0 0 16px;color:${RED}">Welcome to {{ company_name }}! We&rsquo;re excited to have you join our team of experienced professionals. To ensure a smooth and efficient transition, we&rsquo;ve outlined a simple step-by-step onboarding process for you:</p>`
  + `<p style="margin:0 0 16px;color:${GREEN}"><strong>First of all, Congratulations on successfully finishing all your Real Estate Courses. Step into the exciting journey of the real estate world!</strong></p>`

  + '<p style="margin:0 0 4px"><strong>Step 1: After obtaining the criminal record check, the next step is to complete the RECO registration.</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>To register with RECO, kindly generate your login using your student ID on the RECO website (<a href="https://myweb.reco.on.ca/members/Account/Register" style="color:#1d4ed8">https://myweb.reco.on.ca/members/Account/Register</a>).</li>'
  + '<li>To Complete Criminal Background Check on the RECO website.</li>'
  + '<li>Upon successful login, complete the online application for a new salesperson. Following the submission of the application, it will undergo review by the {{ company_name }} Broker of Record.</li>'
  + '<li>Ensure you input the following employer details during the application:'
  + '<ul style="margin:4px 0 0;padding-left:22px">'
  + '<li>Employer #: <strong>5029774</strong></li>'
  + '<li>Employer Name: <strong>Get Home Realty Inc</strong></li>'
  + '</ul></li>'
  + '<li>The RECO processing time for the application is 1 to 3 business days. Once the RECO process is finalized, follow the instructions below to submit the criminal record and TREB registration.</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Step 2: Send a Copy of Criminal Record</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Kindly send a copy of your Criminal Record and Judicial Matters Check to <a href="mailto:Registration@reco.on.ca" style="color:#1d4ed8">Registration@reco.on.ca</a>, ensuring your full name and Student ID are included in the email content and subject line.</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Step 3: TREB Registration</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Use the enclosed link to access the TREB online application form &gt;&gt;&gt; <a href="https://member.trreb.ca/NC__Login?startURL=%2F" style="color:#1d4ed8">https://member.trreb.ca/NC__Login?startURL=%2F</a></li>'
  + '<li>Log in as a &lsquo;NON-MEMBER&rsquo; using your email address and complete the online registration.</li>'
  + `<li>After completing the &lsquo;NON-MEMBER&rsquo; login registration, proceed to register as a salesperson or broker. Once you fill in your personal details, enter <strong style="color:${RED}">&ldquo;Get Home Realty&rdquo;</strong> in the brokerage section.</li>`
  + '<li>Brokerage Id#: <strong>402600</strong></li>'
  + '<li>Additionally, attach a screenshot of your RECO registration from the online portal along with your confirmation of completing the TREB online registration.</li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Step 4: Providing your Basic Details</strong></p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Please provide your essential information, including your full name (First &amp; Last names), contact details, personal email ID and a professional headshot.</li>'
  + '<li>Along with, provide your PREC / SP bank account details for upcoming commission payouts to our accounts team along with Proof documents at <a href="mailto:{{ accounts_email }}" style="color:#1d4ed8">{{ accounts_email }}</a></li>'
  + '</ul>'

  + '<p style="margin:0 0 4px"><strong>Step 5: Business Cards &amp; Signage</strong></p>'
  + '<ul style="margin:0 0 16px;padding-left:22px">'
  + '<li>You will be issued with your personalized business cards.</li>'
  + '</ul>'

  + '<p style="margin:0 0 12px">Should you have any further questions during this process, feel free to reach out. We&rsquo;re here to support you every step of the way and look forward to your success with {{ company_name }}.</p>'
  + '<p style="margin:0 0 16px">Thank you for choosing us as your new brokerage!</p>'

  + RECRUITMENT_SIGNATURE
  + '</div>';

/**
 * Accounts&rsquo; request for the banking details a commission payout is made against, in the wording
 * the Accounts Department sends it in.
 *
 * It asks for the documents rather than collecting them: there is nowhere in this application to put
 * a SIN or a void cheque, and a template that implied otherwise would be inviting the agent to reply
 * with them into a mailbox nobody decided should hold them. The reply goes to Accounts, as it does
 * today.
 *
 * Sent from the accounts mailbox rather than Recruitment&rsquo;s, which is a sender to set on this
 * template in Settings &rarr; Templates — the letterhead below only signs it.
 */
const ACCOUNTING_ONBOARD_BODY: string =
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111827">'
  + '<p style="margin:0 0 12px"><strong>Dear {{ agent_name }},</strong></p>'
  + '<p style="margin:0 0 12px">I hope this email finds you well.</p>'
  + '<p style="margin:0 0 12px">As part of our onboarding and accounting process for <strong>upcoming commission payouts</strong>, we request you to provide the following details based on your business structure to generate tax-related documents under your business name.</p>'
  + '<p style="margin:0 0 14px">Please review the applicable section below and submit the required information.</p>'

  + '<hr style="border:0;border-top:1px solid #d1d5db;margin:0 0 14px">'
  + '<p style="margin:0 0 8px"><strong>1. If you are operating under a PREC (Personal Real Estate Corporation):</strong></p>'
  + '<p style="margin:0 0 8px">A PREC means your commissions are paid to your incorporated business.</p>'
  + '<p style="margin:0 0 4px">Please provide:</p>'
  + '<ul style="margin:0 0 14px;padding-left:22px">'
  + '<li>Incorporation Document</li>'
  + '<li>HST Number</li>'
  + '<li>Void Cheque or Direct Deposit Form (in Corporation Name)'
  + '<ul style="margin:4px 0 0;padding-left:22px">'
  + '<li>Bank Name</li>'
  + '<li>Institution Number</li>'
  + '<li>Transit Number</li>'
  + '<li>Account Number</li>'
  + '</ul></li>'
  + '<li>Registered Business Address</li>'
  + '</ul>'

  + '<hr style="border:0;border-top:1px solid #d1d5db;margin:0 0 14px">'
  + '<p style="margin:0 0 8px"><strong>2. If you are operating as a Sole Proprietor (Individual / Not Incorporated):</strong></p>'
  + '<p style="margin:0 0 8px">A Sole Proprietor means commissions are paid directly to you as an individual.</p>'
  + '<p style="margin:0 0 4px">Please provide:</p>'
  + '<ul style="margin:0 0 12px;padding-left:22px">'
  + '<li>Full Legal Name (as per government ID)</li>'
  + '<li>SIN (Social Insurance Number &ndash; required for T4A)</li>'
  + '<li>HST Number</li>'
  + '<li>Void Cheque or Direct Deposit Form (in your legal name as per bank records)'
  + '<ul style="margin:4px 0 0;padding-left:22px">'
  + '<li>Bank Name</li>'
  + '<li>Institution Number</li>'
  + '<li>Transit Number</li>'
  + '<li>Account Number</li>'
  + '</ul></li>'
  + '<li>Residential Address</li>'
  + '</ul>'
  + `<p style="margin:0 0 14px;color:${RED}"><em>Please confirm that the provided bank account is registered under your name and that you authorize its use for commission payouts as a Sole Proprietor.</em></p>`

  + '<hr style="border:0;border-top:1px solid #d1d5db;margin:0 0 14px">'
  + '<p style="margin:0 0 4px"><strong>Important Notes:</strong></p>'
  + '<ul style="margin:0 0 16px;padding-left:22px">'
  + '<li>Providing complete and accurate details is <strong>mandatory</strong> to ensure timely and compliant commission payouts.</li>'
  + '<li>Payments will only be processed once all required documentation is received and verified.</li>'
  + '<li>Please ensure that the bank account name matches your legal name or registered corporation name, as applicable.</li>'
  + '<li>All information will be kept strictly confidential and used solely for accounting, tax reporting, and payment processing purposes.</li>'
  + '</ul>'

  + '<hr style="border:0;border-top:1px solid #d1d5db;margin:0 0 14px">'
  + '<p style="margin:0 0 12px">Kindly submit the above details and documents at your earliest convenience.</p>'
  + '<p style="margin:0 0 12px">Your prompt cooperation in providing this information will help us facilitate smooth and efficient commission payouts. If you have any questions or require assistance, please feel free to reach out to us.</p>'
  + '<p style="margin:0 0 16px">Thank you for your cooperation and have a great day!</p>'

  + ACCOUNTS_SIGNATURE
  + '</div>';

/**
 * The Training Department&rsquo;s welcome, listing the subjects the onboarding programme covers.
 *
 * The letter that goes out today carries this list as a designed banner image. It is set as text
 * here because the artwork is not among this application&rsquo;s assets, and because a mail client
 * that blocks images — most of them, by default, from an unknown sender — would otherwise show a new
 * agent an empty rectangle where their training programme should be. Attaching the real banner to
 * this template in Settings &rarr; Templates is the way to send the designed version as well.
 */
/**
 * The subjects set as text, for when the designed banner is not available.
 *
 * Rendered into `{{ training_banner }}` by `UserOnboardingService` whenever no banner artwork is
 * installed, so the letter always shows the programme rather than a gap where a picture should be.
 */
export const TRAINING_BANNER_FALLBACK: string =
  '<div style="margin:0 0 18px;padding:16px 18px;border:1px solid #e5e7eb;border-left:6px solid ' + RED + ';background:#fafafa">'
  + '<div style="margin:0 0 10px">{{ logo_img }}</div>'
  + '<p style="margin:0 0 10px;font-size:26px;line-height:1.15;font-weight:700;color:#111827">Onboard<br>Trainings</p>'
  + '<ul style="margin:0;padding-left:18px;list-style:none">'
  // Written out in the case they are set in, rather than upper-cased here: `toUpperCase()` would
  // reach the HTML entities as well and turn `&amp;` into `&AMP;`, which no client decodes.
  + [
    'EXPLORING MLS',
    'ULTIMATE SHOWINGS',
    'DOCUMENTATION',
    'NEGOTIATION SKILLS',
    'LISTING PRESENTATION',
    'TOOLS &amp; SOFT SPOKEN SKILLS',
    'MARKETING &amp; ADVERTISING',
    'PRE-CONSTRUCTIONS',
    'COMMERCIAL',
  ].map((subject) => `<li style="margin:0 0 4px;font-weight:600;letter-spacing:.02em"><span style="color:${RED}">&#10033;</span> ${subject}</li>`).join('')
  + '</ul>'
  + '</div>';

const TRAINING_ONBOARD_BODY: string =
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111827">'
  // The designed banner when the brokerage has installed one, the subjects as text when it has not.
  + '{{ training_banner }}'

  + '<p style="margin:0 0 12px">Welcome to <strong>{{ company_name }}</strong></p>'
  + '<p style="margin:0 0 12px">On behalf of our Training Department and the entire team, we are pleased to welcome you to the brokerage.</p>'
  + '<p style="margin:0 0 12px">At {{ company_name }}, our goal is to provide you with the training, resources, tools, and ongoing support you need to build a successful real estate career. From your initial onboarding and training to your continued professional growth, our team is committed to supporting you at every stage.</p>'
  // No full stop after the name: the brokerage's registered name ends in one ("GET HOME REALTY
  // INC."), and adding another produced "…with GET HOME REALTY INC..".
  + '<p style="margin:0 0 12px">We look forward to working with you, supporting your development, and seeing you achieve your goals with {{ company_name }}</p>'
  // The sign-off that closes this wording — "Yours truly, / Training Department / GET HOME REALTY
  // INC." — is not written here: the shared signature below already renders all three of those
  // lines. Repeating them would sign the letter twice.
  + '<p style="margin:0 0 16px">Wishing you a successful and rewarding journey ahead.</p>'

  + TRAINING_SIGNATURE
  + '</div>';

export const MAIL_EVENTS: Record<string, MailEvent> = {
  // The two onboarding guides are one button on the Users screen; which of them is sent is decided
  // by the agent's own Fresher / Experienced field. They are separate rows here so each can be
  // edited, switched off and given its own attachments without disturbing the other.
  'user.onboard_email': {
    module: 'Onboarding',
    label: 'Agent — Onboarding Guide (Experienced)',
    variables: ['agent_name', 'agent_email', 'company_name', 'broker_of_record', 'broker_email', 'accounts_email', 'attachment_count', 'logo_img', 'onboard_date', 'current_date'],
    default_subject: 'Welcome, {{ agent_name }}! Here’s your onboarding guide to {{ company_name }}',
    default_body_html: ONBOARD_EMAIL_BODY,
  },
  'user.onboard_email_fresher': {
    module: 'Onboarding',
    label: 'Agent — Onboarding Guide (Fresher)',
    // No `attachment_count`: this letter refers to no attachments, so nothing asks the agent to
    // confirm a number of them.
    variables: ['agent_name', 'agent_email', 'company_name', 'broker_of_record', 'broker_email', 'accounts_email', 'logo_img', 'onboard_date', 'current_date'],
    default_subject: 'Welcome, {{ agent_name }}! Here’s your onboarding guide to {{ company_name }}',
    default_body_html: ONBOARD_EMAIL_FRESHER_BODY,
  },
  'user.accounting_onboard_email': {
    module: 'Onboarding',
    label: 'Agent — Accounting Onboarding (Bank Details)',
    variables: ['agent_name', 'agent_email', 'company_name', 'accounts_email', 'logo_img', 'onboard_date', 'current_date'],
    default_subject: 'Onboarding: Request for Bank Details for Commission Payout Setup',
    default_body_html: ACCOUNTING_ONBOARD_BODY,
  },
  'user.training_onboard_email': {
    module: 'Onboarding',
    label: 'Agent — Training Onboarding',
    variables: ['agent_name', 'agent_email', 'company_name', 'logo_img', 'training_banner', 'onboard_date', 'current_date'],
    default_subject: 'Onboarding: Training Department',
    default_body_html: TRAINING_ONBOARD_BODY,
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
  /**
   * An appointment is coming up.
   *
   * Sent to the person whose calendar it is, at the lead times in `REMINDER_LEAD_MINUTES`, and only
   * when they ticked "Remind me". The checkbox stored a flag that nothing on the server ever read,
   * so an agent could tick it for a showing and hear nothing.
   */
  'calendar.event_reminder': {
    module: 'Calendar',
    label: 'Calendar — Appointment Reminder',
    variables: ['user_name', 'event_title', 'event_type', 'event_date', 'event_time', 'event_end_time', 'when_phrase', 'location', 'attendees', 'contact_phone', 'contact_email', 'notes', 'deal_number', 'property_address', 'company_name', 'current_date'],
    default_subject: '{{ when_phrase }}: {{ event_title }} at {{ event_time }}',
    default_body_html:
      '<p>Hello {{ user_name }},</p>'
      + '<p>A reminder that <strong>{{ event_title }}</strong> is {{ when_phrase }}.</p>'
      + '<table style="border-collapse:collapse;font-size:14px;margin:10px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">What</td><td style="padding:4px 0;font-weight:600">{{ event_title }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Type</td><td style="padding:4px 0">{{ event_type }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">When</td><td style="padding:4px 0;font-weight:600">{{ event_date }} at {{ event_time }}{{ event_end_time }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Where</td><td style="padding:4px 0">{{ location }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">With</td><td style="padding:4px 0">{{ attendees }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Contact</td><td style="padding:4px 0">{{ contact_phone }} {{ contact_email }}</td></tr>'
      + '<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Deal</td><td style="padding:4px 0">{{ deal_number }} {{ property_address }}</td></tr>'
      + '</table>'
      + '<p>{{ notes }}</p>'
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

  /*
   * ------------------------------------------------------------------ CRM
   *
   * The CRM's own emails to LEADS. `module: 'CRM'` is what puts them in their own group on
   * Settings → Templates — that screen groups by this field, so the section is the grouping rather
   * than a second screen. Campaign templates are a different table (`campaign_templates`) and a
   * different screen entirely; nothing here touches them.
   *
   * EVERY KEY BELOW HAS A SENDER. That is a rule, not a coincidence: `birthday` and `anniversary`
   * were once switches on a settings screen with nothing behind them, and were deleted for exactly
   * that reason. A key registered here creates an editable, deactivatable template row, and a row
   * that no code ever reads is a control that lies about what it does. If a CRM email is added
   * later, register it in the same change that sends it.
   *
   * The bodies are the ones these emails have always sent, moved here verbatim so switching to
   * template resolution changes nothing a recipient sees on day one — the point is that they are
   * now EDITABLE, not that they are different. `{{ signature }}` is the agent's own sign-off,
   * appended by the sender; it stays a variable so a brokerage that does not want it can remove it
   * from the template without touching code.
   */
  /*
   * The welcome, sent once to a lead shortly after they arrive — whoever they arrived from.
   *
   * WHY THE SUBJECT USES A VARIABLE. "Welcome to Get Home Realty" is the brokerage this was written
   * for, and hard-coding it would be a second place the company name lives. `brokerage_name` reads
   * `company_settings.name`, so renaming the brokerage renames the email and nobody has to remember
   * this file.
   *
   * `agent_*` FALLS BACK TO THE BROKERAGE rather than rendering blank. A lead with no agent is sent
   * from the brokerage account, and a default template that greeted them from "" and gave them ""
   * to call would be worse than one that names the brokerage twice. A template that wants to
   * distinguish the two cases has `brokerage_*` to do it with.
   */
  'crm.lead_welcome': {
    module: 'CRM',
    label: 'CRM — New Lead Welcome Email (automatic, once per lead)',
    variables: [
      'lead_first_name', 'lead_name',
      'agent_name', 'agent_email', 'agent_phone',
      'brokerage_name', 'brokerage_contact',
      'signature', 'current_date', 'current_year',
    ],
    default_subject: 'Welcome to {{ brokerage_name }}',
    default_body_html:
      '<p>Hello {{ lead_first_name }},</p>'
      + '<p>Thank you for getting in touch with {{ brokerage_name }} — we are glad you did, and we are '
      + 'looking forward to helping you.</p>'
      + '<p>I am {{ agent_name }}, and I will be looking after you from here. Whenever you have a '
      + 'question — a property, a neighbourhood, or just where to start — reply to this email or '
      + 'reach me directly:</p>'
      + '<p>{{ agent_email }}<br />{{ agent_phone }}</p>'
      + '<p>{{ brokerage_contact }}</p>'
      + '<p>Talk soon,</p>',
  },

  'crm.birthday_greeting': {
    module: 'CRM',
    label: 'CRM — Birthday Greeting (automatic, on the day)',
    variables: ['lead_name', 'agent_name', 'signature', 'current_date', 'current_year'],
    default_subject: 'Happy Birthday!',
    default_body_html:
      '<p>Dear {{ lead_name }},</p>'
      + '<p>Wishing you a very happy birthday from all of us. We hope you have a wonderful day.</p>'
      + '<p>If there\'s anything property-related we can help with, just reply to this email.</p>'
      + '<p>With warm wishes,</p>',
  },
  'crm.anniversary_greeting': {
    module: 'CRM',
    label: 'CRM — Wedding Anniversary Greeting (automatic, on the day)',
    variables: ['lead_name', 'agent_name', 'signature', 'current_date', 'current_year'],
    default_subject: 'Happy Anniversary!',
    default_body_html:
      '<p>Dear {{ lead_name }},</p>'
      + '<p>Happy anniversary! Wishing you both a wonderful day and many more to come.</p>'
      + '<p>If a move is part of your plans, we\'d be glad to help whenever the time feels right.</p>'
      + '<p>With warm wishes,</p>',
  },
  'crm.wedding_congratulations': {
    module: 'CRM',
    label: 'CRM — Wedding Congratulations',
    variables: ['lead_name', 'agent_name', 'wedding_date', 'signature', 'current_date', 'current_year'],
    default_subject: 'Congratulations on your wedding!',
    default_body_html:
      '<p>Dear {{ lead_name }},</p>'
      + '<p>Congratulations on your wedding{{ wedding_date }}! Wishing you both every happiness in this next chapter.</p>'
      + '<p>If a new home is part of your plans together, I\'d be glad to help whenever the time feels right.</p>'
      + '<p>With warm wishes,</p>',
  },
  'crm.seasonal_wishes': {
    module: 'CRM',
    label: 'CRM — Seasonal Wishes',
    variables: ['lead_name', 'agent_name', 'season', 'year', 'signature', 'current_date', 'current_year'],
    default_subject: '{{ season }} wishes from all of us',
    default_body_html:
      '<p>Dear {{ lead_name }},</p>'
      + '<p>Wishing you a wonderful {{ season }} {{ year }} — thank you for your trust this year.</p>'
      + '<p>If there\'s anything property-related I can help with in the year ahead, just reply to this email.</p>',
  },

  /*
   * The five CRM notifications that reach a STAFF inbox rather than a lead's.
   *
   * All six above go to a lead; these tell an agent something happened — a lead landed on their
   * desk, a follow-up came due, a campaign finished. They travel through `NotificationDispatcher`,
   * which also carries Transaction Desk's notifications, so the template is resolved by
   * `CrmEventNotifier` and handed to the dispatcher as an email OVERRIDE. Desk call sites pass no
   * override and keep the dispatcher's own default body: the separation is structural, not a flag.
   *
   * CONFIRMED TO ACTUALLY SEND before being registered. Each of these five declares
   * `email: 'live'` in the notification-preference catalogue, and `lead_task_due` was observed
   * delivering by email in the development log. Nothing here is a control over an email that does
   * not exist.
   *
   * `{{ open_link }}` is a full URL the dispatcher would otherwise append itself. A template that
   * removes it still sends — it simply has no button, which is a brokerage's choice to make.
   */
  'crm.lead_new': {
    module: 'CRM',
    label: 'CRM — New Lead Added To Your Book',
    variables: ['user_name', 'lead_name', 'lead_source', 'open_link', 'current_date', 'current_year'],
    default_subject: 'New lead: {{ lead_name }}',
    default_body_html:
      '<p>Hello {{ user_name }},</p>'
      + '<p><strong>{{ lead_name }}</strong> has been added to your leads{{ lead_source }}.</p>'
      + '<p><a href="{{ open_link }}">Open the lead</a></p>',
  },
  'crm.lead_assigned': {
    module: 'CRM',
    label: 'CRM — Lead Assigned To You',
    variables: ['user_name', 'lead_name', 'actor_name', 'open_link', 'current_date', 'current_year'],
    default_subject: 'New lead assigned: {{ lead_name }}',
    default_body_html:
      '<p>Hello {{ user_name }},</p>'
      + '<p><strong>{{ lead_name }}</strong> has been assigned to you{{ actor_name }}.</p>'
      + '<p><a href="{{ open_link }}">Open the lead</a></p>',
  },
  'crm.lead_task_due': {
    module: 'CRM',
    label: 'CRM — Follow-up / Task Due Reminder',
    variables: ['user_name', 'task_title', 'lead_name', 'due_date', 'open_link', 'current_date', 'current_year'],
    default_subject: 'Follow-up due: {{ task_title }}',
    default_body_html:
      '<p>Hello {{ user_name }},</p>'
      + '<p><strong>{{ task_title }}</strong> on {{ lead_name }} is due {{ due_date }}.</p>'
      + '<p><a href="{{ open_link }}">Open the lead</a></p>',
  },
  'crm.meta_lead_received': {
    module: 'CRM',
    label: 'CRM — Facebook (Meta) Lead Received',
    variables: ['user_name', 'lead_name', 'form_name', 'open_link', 'current_date', 'current_year'],
    default_subject: 'New Facebook lead: {{ lead_name }}',
    default_body_html:
      '<p>Hello {{ user_name }},</p>'
      + '<p><strong>{{ lead_name }}</strong> submitted {{ form_name }}.</p>'
      + '<p><a href="{{ open_link }}">Open the lead</a></p>',
  },
  'crm.campaign_completed': {
    module: 'CRM',
    label: 'CRM — Campaign Finished',
    variables: ['user_name', 'campaign_name', 'recipients', 'sent', 'failed', 'open_link', 'current_date', 'current_year'],
    default_subject: 'Campaign finished: {{ campaign_name }}',
    default_body_html:
      '<p>Hello {{ user_name }},</p>'
      + '<p><strong>{{ campaign_name }}</strong> finished: {{ sent }} of {{ recipients }} sent{{ failed }}.</p>'
      + '<p><a href="{{ open_link }}">Open the campaign</a></p>',
  },
  'crm.campaign_failed': {
    module: 'CRM',
    label: 'CRM — Campaign Could Not Be Completed',
    variables: ['user_name', 'campaign_name', 'open_link', 'current_date', 'current_year'],
    default_subject: 'Campaign stopped: {{ campaign_name }}',
    /*
     * No technical detail, deliberately, matching the notifier's own rule: stack traces, SMTP
     * responses and server paths stay in the log where they are useful. A campaign owner cannot act
     * on "ECONNREFUSED 10.0.0.4:587" and it should not be in their inbox.
     */
    default_body_html:
      '<p>Hello {{ user_name }},</p>'
      + '<p><strong>{{ campaign_name }}</strong> stopped before it finished. Open it to review the details.</p>'
      + '<p><a href="{{ open_link }}">Open the campaign</a></p>',
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
  // wording, signature block and logo replaced it; then that version, whose letterhead still gave
  // the #405-218 / L6R 0M8 address, until it was settled in favour of the contracts' address.
  'user.onboard_email': [
    '2e89930be4e11d4fdb33552fdec7b0894b18eda3359ac68b01e88cff17a04c3e',
    '069203e53e38e551ab6da01f7f7146058efead094284a0b39e35168b067da6f5',
    // Recruitment's own letterhead, before all four letters moved to the shared Accounts design.
    '255e67d6b94e7ef6280a8f0577a1e14c76af01d599cae18ec26e28cb2eacfe91',
  ],
  // The covering note that referred to an attached agreement, shipped until 2026-07-30, when the
  // agreement itself — filled in from the agent's profile — replaced it; then that version, which
  // still printed the paper form's "[Agent's Full Name]" and "[Agent's Address]" labels beside the
  // details they had already been filled in with.
  'user.contract_agreement': [
    '152ec34e4ebccf846b57799efb8ebcf34b78f2a6d53f56c1331536a1bda6b767',
    'd307fe3d8e5655b0cf82d8bca4abde82d1969cfe0b14b7502c2579a9230f3755',
  ],
  // The fresher letter as first shipped on 2026-08-14, with the congratulations line in plain black.
  // It is green from later the same day.
  'user.onboard_email_fresher': [
    '458219b5fddfaa4c16f699903ad34d29086aa61fbe6d565b8be5bfe976b8c548',
    // Green congratulations line, letterhead still on the #405-218 / L6R 0M8 address.
    '66c72b3d9b2ab16208bba98d040652d3381616416db8294c991a45db1b6f0915',
    // Before the shared signature.
    'dfe81a9dacdb452b0a91e1b308cec3f7601a3e38a4ec35db9ac9af4728a8ccd5',
  ],
  // As first shipped on 2026-08-14; then with the contracts' address on the letterhead, until the
  // subjects became `{{ training_banner }}` and the sign-off became the Department of Training.
  'user.training_onboard_email': [
    '2b1ca76f221094b3ef017b8437edc932de690af3ab2acb446763602cc2917419',
    '0a08e12253cd055c32265ec71337b18dcfcb2669b4db76ed54a89528f1078549',
    // Before the shared signature.
    '5f93baa7b472e14c0ce313d81b32fd1eb5efe7b668c1c956ad53164758159e28',
    // On the shared signature, still answering on Recruitment's mailbox rather than Training's own.
    'b5348ef31c23c3d49b56dad3a71aa9b7ee4f19589788e0768d89e97619d2d59a',
    // The original three-paragraph welcome, before the Training Department's own wording replaced it.
    '2a0f4dc1f3b0a38dc00d4ea316b71892765454807635d553d633d75671f98145',
  ],
  // The accounting letter as first shipped on 2026-08-14, signed off by "Accounts Department" on
  // Recruitment's letterhead; then with Kalyani Sappa's signature on the shared letterhead, until
  // the sent copy showed the closing paragraphs and the department's own signature block.
  'user.accounting_onboard_email': [
    '7c1035222d6a8b6a672d5cb420c7d7dcedce0ede7ff6d25ae55820fc2a5cee73',
    'f7abd571b0eea88fd4d3ad92c99ae5e1edd3993b94cf1e3b0cf919bbe816ecc1',
    // With Kalyani Sappa's name and title, before the signature lost them.
    '2f7a2b9a3656ab43c861f84975da93dda0f43048bbe2adde78b3214a036d2bbb',
  ],
};

export const variablesFor = (key: string): string[] => MAIL_EVENTS[key]?.variables ?? [];

/**
 * The merge variables whose value IS markup, and which must therefore not be escaped.
 *
 * This list is the whole risk of escaping by default, so it is enumerated rather than guessed at,
 * and each entry names what builds it:
 *
 *   logo_img           `<img …>` for the brand logo — user-onboarding.service.ts `logoImg()`
 *   training_banner    the Onboard Trainings banner, or the subjects as text when no artwork is
 *                      installed — user-onboarding.service.ts `trainingBanner()`
 *   commission_terms   the `<li>` lines of the agreement's Commission Structure —
 *                      user-onboarding.service.ts `commissionTerms()`
 *   agent_address      the agent's address, or a ruled blank — user-onboarding.service.ts `vars()`
 *   company_address    the brokerage's address, or a ruled blank — same
 *   agent_type         "Fresher Agent" / "Experienced Agent [Past Brokerage …]", the brokerage name
 *                      or a ruled blank inside it — user-onboarding.service.ts `agentType()`
 *   documents_table    a `<tr>`-per-document table — document-mail.service.ts `outcomeTable()`
 *                      and document-reminder.service.ts
 *   pending_docs       a `<ul>` of outstanding documents — documents.service.ts
 *   transaction_button a styled `<a>` wrapped in a `<p>` — reminder-sweep.service.ts
 *
 * Everything else is data — a name, an address, a date, a reason somebody typed — and is escaped.
 *
 * ADDING TO THIS LIST IS A SECURITY DECISION. A variable named here is trusted to be safe HTML, so
 * whatever builds it owns that guarantee. Note that `logoImg()` already strips `[<>"&]` from the
 * company name before interpolating it into the `alt` attribute — that is the shape a builder on
 * this list has to have. `trainingBanner()` meets it the same way: everything it emits is either
 * fixed markup from this file or base64 read off disk, with nothing a user typed reaching it. So does
 * `commissionTerms()`, which interpolates only numbers — every value it prints has been through
 * `Number()` and `Math.floor`, and no free text from the profile reaches the markup.
 *
 * The three agreement variables that CARRY TYPED TEXT — `agent_address`, `company_address` and the
 * past-brokerage name inside `agent_type` — are escaped by the service that builds them, before the
 * ruled blank is put around them. That is the only reason they can be on this list: the markup in
 * them is this file's, and the data in them has already been made safe.
 *
 * The whole contract group was missing from this list until 2026-08-14, and the consequence was
 * visible in every agreement sent: the Commission Structure arrived as `&lt;li&gt;Flat 95-05% split…`
 * and a missing address as `&lt;span style=…&gt;______&lt;/span&gt;`, in the email and in the signed
 * PDF generated from it.
 */
const HTML_VARIABLES = new Set([
  'logo_img', 'training_banner',
  'commission_terms', 'agent_address', 'company_address', 'agent_type',
  'documents_table', 'pending_docs', 'transaction_button',
]);

/** The five characters that change the meaning of HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain, safe {{ variable }} substitution — no eval. Unknown tokens → empty string.
 *
 * VALUES ARE HTML-ESCAPED BY DEFAULT. They were not, and the consequence was not hypothetical: the
 * company email address this application ships with is
 * `info@GetHomeRealty.ca & Commissionpayouts@gethomerealty.ca`, whose bare `&` was already being
 * emitted into HTML mail as an unterminated entity. Any brokerage named "Smith & Jones" hit the same
 * thing on its first send, and a lead named `<script>…` — which `POST /api/leads` accepts and stores
 * verbatim — reached client inboxes as markup. Found as S-M9 in the CRM › Settings audit and again
 * as CRM-LEADS-M01.
 *
 * The subject line is rendered through here too, where escaping is equally right: a subject is
 * plain text, and `&amp;` in a header is the correct encoding of an ampersand.
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return '';
    const value = vars[key];
    if (value === null || value === undefined) return '';
    const text = String(value);
    return HTML_VARIABLES.has(key) ? text : escapeHtml(text);
  });
}
