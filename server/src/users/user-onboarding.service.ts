import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { MAIL_EVENTS, SUPERSEDED_BODY_HASHES, TRAINING_BANNER_FALLBACK, renderTemplate, variablesFor } from '../email/mail-event-registry';
import type { MailAttachment } from '../email/mailer.service';
import { parseJsonObject } from '../common/serialize';
import { renderContractPdf } from './contract-pdf';

/**
 * The emails sent to an agent from the Users screen: the onboarding guide, Accounts' request for
 * banking details, the Training Department's welcome, and the contract agreement.
 *
 * They are ordinary email templates, editable in Settings → Templates with their own subject,
 * body, sender and attachments — the resignation-letter sample, the 30-day action plan, the
 * contract PDF. What is different here is that nothing is sent blind: the screen asks for the
 * message as it will actually arrive for THIS agent, with the variables already filled in, and
 * whatever comes back from that review is what goes out.
 *
 * The edit is per-send, not to the template. Adjusting a sentence for one agent must not quietly
 * rewrite what every future agent receives; changing the template itself is what the Templates
 * screen is for.
 */

/**
 * `media` is not an onboarding letter. It is the per-listing Media & Marketing Fee Agreement, sent
 * from the same screen because the same person sends it to the same agent — but it is signed once
 * per LISTING rather than once when somebody joins, so expect it to be sent repeatedly.
 */
export type OnboardingKind = 'onboard' | 'contract' | 'accounting' | 'training' | 'media';

/**
 * Which template each button sends.
 *
 * `onboard` is the one that is not a constant: a fresher and an agent transferring in receive
 * letters with nothing in common — one registers with RECO and TREB from scratch, the other resigns
 * and waits on a transfer — so the agent's own Fresher / Experienced field decides which goes. That
 * field is required on the user form, and an older record that has neither still gets the
 * experienced letter, which is the one every agent received before this existed.
 */
const ONBOARD_EXPERIENCED = 'user.onboard_email';
const ONBOARD_FRESHER = 'user.onboard_email_fresher';
const TRAINING_EMAIL = 'user.training_onboard_email';

/**
 * Every template a kind can resolve to. `onboard` has two; the rest have one.
 *
 * Kept as the single list so a lookup that has no agent to consult — reading back a file attached to
 * one of these emails — can still be confined to the templates that button actually sends.
 */
const KIND_EVENT_KEYS: Record<OnboardingKind, string[]> = {
  onboard: [ONBOARD_EXPERIENCED, ONBOARD_FRESHER],
  contract: ['user.contract_agreement'],
  accounting: ['user.accounting_onboard_email'],
  training: [TRAINING_EMAIL],
  media: ['user.listing_media_agreement'],
};

/** The kinds that carry a signable PDF built from the reviewed message. */
const GENERATES_DOCUMENT: readonly OnboardingKind[] = ['contract', 'media'];

/** A file picked in the review dialog, attached to this one send. */
export interface AdHocAttachment {
  filename: string;
  content_type?: string;
  /** Base64; a full `data:` URI from a file input is accepted too. */
  data: string;
}

/**
 * Ceiling for files attached to a single send, on top of whatever the template already carries.
 * Matches the template limit for the same reason: providers reject an oversized message outright,
 * and a send that fails after the fact is worse than a file refused up front.
 */
export const MAX_ADHOC_BYTES = 5 * 1024 * 1024;
export const MAX_ADHOC_FILES = 5;

/**
 * The documents the onboarding letter refers to, shipped with the server and put on the template
 * the first time it is used. Resolved from this file rather than the working directory, so it holds
 * whether the process is started from `server/`, systemd or a container.
 */
const ONBOARD_DOC_DIR = path.resolve(__dirname, '..', '..', 'assets', 'onboarding');
const ACTION_PLAN = 'First 30 Days Action Plan.pdf';

/**
 * Both sample sheets go to every agent, and the agent picks the style they want.
 *
 * Deliberately not chosen for them: this application records no gender, and guessing one from a name
 * to decide which sheet somebody receives would be wrong often enough — and wrong in a way worth
 * avoiding — that sending both is the better answer. The letter asks them to indicate a style
 * preference, which reads the same either way.
 */
const SAMPLE_HEADSHOTS = ['Sample Headshots - Male.pdf', 'Sample Headshots - Female.pdf'];

/**
 * The Onboard Trainings artwork, ALSO sent as a file.
 *
 * It already travels inside the message as the banner people read. Attaching it as well is not a
 * duplicate for the sake of it: an inline image is awkward to save, forward or print, and this one
 * is a list of the nine courses a new agent is booked onto — a thing they will want to keep.
 *
 * Named for the reader rather than for the disk. `onboard-trainings-banner.jpg` is what the file is
 * called on the server; `Onboard Trainings.jpg` is what should appear in somebody's inbox.
 */
const TRAINING_BANNER_DOC = 'Onboard Trainings.jpg';

/**
 * Files that go to some agents and not others, and the `gender` each one belongs to.
 *
 * Both sheets sit on the template so both are visible and replaceable in Settings → Templates; which
 * of them travels is decided per agent, here, when the email is built. A file not named in this map
 * goes to everyone, so adding an ordinary document to a template needs no thought about who gets it.
 */
const GENDERED_DOCUMENTS: Record<string, string> = {
  'Sample Headshots - Male.pdf': 'Male',
  'Sample Headshots - Female.pdf': 'Female',
};

/**
 * Where an agent sends their banking details, when Company Settings does not say.
 *
 * Settings holds ONE address for the brokerage, optionally two separated by "&" — the general one
 * and the payouts one. It currently holds only `info@`, and with that as the fallback both
 * onboarding letters asked a new agent to send their SIN, void cheque and incorporation documents to
 * the brokerage's public inbox. This is the address Accounts actually collects them at, so it is
 * what the letters say until Settings carries a payouts address of its own.
 */
const ACCOUNTS_EMAIL = 'Commissionpayouts@gethomerealty.ca';

/**
 * Which shipped documents each template starts out carrying, put on it the first time it is used.
 *
 * The action plan appears twice on purpose. It is one file on disk attached to two templates, not
 * two copies to keep in step: the experienced agent's letter sends it as part of the recruitment
 * pack, and the Training Department's letter sends it as the plan behind the subjects it lists. An
 * agent who receives both gets the same document twice, which is what happens today when Recruitment
 * and Training each send their own copy.
 *
 * The fresher letter gets the headshots but NOT the resignation template: it asks them for a
 * professional headshot and issues their business cards from it, while a newly licensed agent has no
 * brokerage to resign from and no use for a letter telling them how.
 *
 * A template not named here starts empty — the accounting letter refers to no documents, and
 * attaching one to a letter that never mentions it is how a new agent ends up ignoring attachments.
 */
const SEEDED_DOCUMENTS: Record<string, string[]> = {
  [ONBOARD_EXPERIENCED]: [
    'Agent Resignation Letter Template.pdf',
    ...SAMPLE_HEADSHOTS,
    ACTION_PLAN,
  ],
  [ONBOARD_FRESHER]: [...SAMPLE_HEADSHOTS],
  [TRAINING_EMAIL]: [ACTION_PLAN, TRAINING_BANNER_DOC],
};

export interface OnboardingPreview {
  kind: OnboardingKind;
  event_key: string;
  subject: string;
  html: string;
  to: string;
  variables: string[];
  attachments: { id: number; filename: string; size: number }[];
  /**
   * The document built from this message and attached to the send — the agreement itself, for the
   * contract. Named here so the screen can list it and offer it for reading before it goes; its size
   * is not known until it is rendered.
   */
  generated_document: string | null;
  /**
   * Which of the brokerage's five standard agreements these terms are, for the contract only —
   * `null` on the other emails, and on a contract whose split is not one of the five.
   */
  contract_variant: string | null;
  sender: string | null;
  /** Set when something would make the send fail or arrive incomplete. */
  warning: string | null;
  /** Which warning it is, so the screen can reason about it rather than matching on the words. */
  warning_kind: 'no_recipient' | 'template_off' | null;
}

/**
 * The signature logo, as the review screen renders it and as the message carries it.
 *
 * The pattern matches the logo endpoint with any host and any `?v=`, because the body being sent is
 * whatever came back from the review — rendered against the address that review was loaded from.
 */
const LOGO_SRC = /src="[^"]*\/api\/company-settings\/logo[^"]*"/i;
const LOGO_CID = 'brand-logo';

/**
 * The designed "Onboard Trainings" banner, if the brokerage has installed one.
 *
 * Dropped into `server/assets/onboarding/` under this name with any ordinary image extension. There
 * is no upload screen for it because it is artwork that changes when the training programme does,
 * not per brokerage — replacing it is replacing the file.
 *
 * Carried the opposite way round to the logo, and for the opposite reason: the logo is a user upload
 * that already has an endpoint to serve it, while this is a file on disk with none, so the review
 * screen gets it as a `data:` URI and the message that goes out gets it as `cid:`. Both halves are
 * needed — a review screen cannot render `cid:`, and Gmail drops `data:` images.
 */
const BANNER_STEM = 'onboard-trainings-banner';
const BANNER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const BANNER_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
const BANNER_CID = 'training-banner';

/** What a seeded document should announce itself as. Everything but the artwork is a PDF. */
const contentTypeFor = (filename: string): string => {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return BANNER_MIME[ext] ?? 'application/pdf';
};
/** Matches the banner however it reached the body — as the data: URI, or already swapped to cid:. */
const BANNER_SRC = /src="(?:data:image\/[a-z+]+;base64,[^"]+|cid:training-banner)"/i;

/**
 * What a detail the profile does not hold looks like in the contract: the ruled blank of the paper
 * form, to be completed by hand. An empty gap would read as though the term simply does not apply.
 */
const BLANK = '<span style="color:#9ca3af">____________________________</span>';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "1st", "2nd", "23rd" — the agreement is dated the way the paper form is written. */
const ordinal = (day: number): string => {
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');
  return `${day}${suffix}`;
};

/** A percentage as it should read in a contract: a whole number where it is one, and blank at zero. */
const pct = (value: unknown): string => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
};

/** The other side of a split. Written out so 95 never appears without the 5 that goes with it. */
const complement = (share: string): string => (share ? pct(100 - Number(share)) || '0' : '');

/** Zero-padded, the way the agreement writes a split: 95-05, not 95-5. */
const pad2 = (share: string): string => (share.length === 1 ? `0${share}` : share);

/**
 * Make typed text safe to place inside the agreement's markup.
 *
 * WHY THIS EXISTS AND WHY IT MATTERS MORE THAN IT LOOKS. `agent_address`, `company_address` and the
 * past-brokerage name inside `agent_type` are on the mail renderer's HTML_VARIABLES allow-list —
 * the short list of merge values that are NOT escaped at render time, because the markup around
 * them (the ruled blank, the bracketed label) is this file's own. That allow-list is only safe
 * because of this function: it is the single point at which somebody's typed address stops being
 * able to carry markup into an email and into the signed PDF generated from it.
 *
 * `'` IS ESCAPED, though the three values all land in TEXT CONTENT today — `residing at {{
 * agent_address }}` — where an apostrophe is harmless. It is escaped anyway because the safety of
 * this depends on a fact about the TEMPLATE, and templates are edited in Settings → Templates by
 * people who have no reason to know that. The day one of these moves inside a single-quoted
 * attribute, an address of `x' onmouseover='…` would be an injection. Escaping all five characters
 * costs nothing — an apostrophe renders as `'` in every mail client — and removes the trap.
 */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * What the generated agreement is called. Kept to characters that survive every mail client and
 * filesystem, and short enough to read in an attachment strip.
 */
/**
 * The five agreements in circulation, by the split they are drawn up for.
 *
 * The app does not pick one of these files and send it — it writes the agreement from the agent's own
 * record, which is why the wording is right for any split. This list answers a different question:
 * WHICH of the documents the brokerage has on file this agent's terms correspond to, so the person
 * pressing Send can recognise the agreement before it goes.
 *
 * A split that is not on this list is not an error. It means the terms recorded for this agent are
 * not one of the standard five, and saying so is more use than naming the nearest one.
 */
const CONTRACT_VARIANTS = new Set([
  '95-05 + 60-40',
  '95-05 + 70-30',
  '90-10',
  '90-10 + 70-30',
  '90-10 + 60-40',
]);

/** The deal count the tiered agreements are written for. A different one is a different document. */
const TIERED_THRESHOLD = 10;

const safeName = (agentName: string): string =>
  agentName.replace(/[^\w\s.-]/g, '').trim().slice(0, 60) || 'Agent';

const documentName = (agentName: string, variant: string | null): string =>
  // The split in the filename so a signed copy can be filed and found by the terms it is on, which
  // is how the brokerage's own five documents are named.
  `Independent Contractor Agreement${variant ? ` ${variant}` : ''} - ${safeName(agentName)}.pdf`;

/*
 * No split in this one's name, and no listing either. The property is a ruled blank the sender fills
 * in, so it is not known here — naming the file after something this code cannot read would produce
 * "… - .pdf" on every send. The agent's name is the one thing that is always known.
 */
const mediaDocumentName = (agentName: string): string =>
  `Listing Media and Marketing Fee Agreement - ${safeName(agentName)}.pdf`;

@Injectable()
export class UserOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
  ) {}

  /**
   * The brand logo for the signature block, as a complete <img> tag or nothing at all.
   *
   * Referenced by URL rather than embedded: `/api/company-settings/logo` is deliberately public
   * for this exact use (see CompanySettingsController), a `cid:` attachment cannot render in the
   * review screen, and Gmail drops `data:` images so an embedded copy would look right here and
   * arrive broken. `?v=` pins it to the settings timestamp, so the endpoint's immutable caching
   * applies and replacing the logo still busts it.
   *
   * `baseUrl` is the address the browser reached this API on, which is all this URL has to satisfy:
   * the review screen loads it over HTTP, and the copy that goes to the agent is swapped for the
   * image itself on the way out (see `embedLogo`).
   */
  private logoImg(company: { name: string; logo_path: string | null; updated_at: Date | null }, baseUrl: string): string {
    if (!company.logo_path || !baseUrl) return '';
    const version = company.updated_at ? company.updated_at.getTime() : '';
    const alt = company.name.replace(/[<>"&]/g, '');
    return `<img src="${baseUrl}/api/company-settings/logo?v=${version}" alt="${alt}" width="132"`
      + ' style="width:132px;max-width:132px;height:auto;display:block;border:0">';
  }

  /**
   * The training banner as the review screen will show it, or the subjects as text when no artwork
   * is installed.
   *
   * The fallback is not a placeholder for a missing image — it is the same nine subjects the banner
   * shows, set as text, so the letter reads correctly either way and a brokerage that never installs
   * artwork is not sending an empty rectangle to every new agent.
   */
  private async trainingBanner(): Promise<string> {
    const found = await this.bannerFile();
    if (!found) return TRAINING_BANNER_FALLBACK;
    try {
      const bytes = await fs.readFile(found.abs);
      // Sized in the tag as well as the style because Outlook ignores CSS width on images. 420 for a
      // portrait banner: at the 560-odd pixels a message body gets it would stand a full screen tall
      // before the letter began.
      return `<img src="data:${found.mime};base64,${bytes.toString('base64')}" alt="Onboard Trainings"`
        + ' width="420" style="width:100%;max-width:420px;height:auto;display:block;border:0;margin:0 0 18px">';
    } catch {
      return TRAINING_BANNER_FALLBACK; // present but unreadable — the subjects still have to arrive
    }
  }

  /** The installed banner, whichever image format it was dropped in as. */
  private async bannerFile(): Promise<{ abs: string; mime: string } | null> {
    for (const ext of BANNER_EXTENSIONS) {
      const abs = path.join(ONBOARD_DOC_DIR, `${BANNER_STEM}${ext}`);
      try {
        await fs.access(abs);
        return { abs, mime: BANNER_MIME[ext] };
      } catch { /* not this extension */ }
    }
    return null;
  }

  /**
   * Swap the banner's inline data for a `cid:` reference and carry the image alongside the message.
   *
   * Same bargain as the logo: the review screen needs something a browser can render and the agent's
   * mail client needs something Gmail will not strip. Matched on the src rather than the filename
   * because the body being sent is whatever came back from the review.
   */
  private async embedBanner(html: string): Promise<{ html: string; file: MailAttachment | null }> {
    if (!BANNER_SRC.test(html)) return { html, file: null };

    const found = await this.bannerFile();
    if (!found) return { html, file: null };
    try {
      const data = await fs.readFile(found.abs);
      return {
        html: html.replace(BANNER_SRC, `src="cid:${BANNER_CID}"`),
        file: { data: data.toString('base64'), name: path.basename(found.abs), mime: found.mime, cid: BANNER_CID },
      };
    } catch {
      return { html, file: null };
    }
  }

  /** "Fresher Agent", or "Experienced Agent" with the brokerage they came from, as the form has it. */
  private agentType(profile: Record<string, unknown>): string {
    const experience = String(profile.experience ?? '').trim();
    if (experience === 'Experienced') {
      const previous = String(profile.prev_brokerage ?? '').trim();
      return `Experienced Agent [Past Brokerage Name: ${escapeHtml(previous) || BLANK}]`;
    }
    return experience === 'Fresher' ? 'Fresher Agent' : BLANK;
  }

  /**
   * The commission lines of the agreement, from the split recorded on the agent's profile — the one
   * part that differs between copies of this contract.
   *
   * Two shapes, matching the two versions in circulation: a flat split on everything, or the tiered
   * one where the first N deals pay differently and lease is flat. The brokerage-lead line is only
   * written when a separate lead split is actually recorded, since silence there means the ordinary
   * split applies — stating a proportion nobody agreed to would be worse than omitting the line.
   *
   * With no split recorded at all the lines are left ruled, so the gap is visible rather than a
   * contract that quietly promises nothing.
   */
  private commissionTerms(profile: Record<string, unknown>): string {
    const agent = pad2(pct(profile.agent_comm_pct));
    const brokerage = pad2(pct(profile.brok_comm_pct) || complement(agent));
    const lease = pad2(pct(profile.lease_comm_pct));
    const threshold = Math.floor(Number(profile.completed_deals) || 0);
    const nextAgent = pad2(pct(profile.upgrade_agent_pct));
    const nextBrokerage = pad2(pct(profile.upgrade_brok_pct) || complement(nextAgent));
    const leadAgent = pad2(pct(profile.brokerage_lead_pct));
    const leadBrokerage = pad2(pct(profile.brokerage_lead_brok_pct) || complement(leadAgent));

    const note = (text: string): string =>
      `<br><em style="font-size:12px;color:#4b5563">[${text}]</em>`;

    const lines: string[] = [];
    if (!agent) {
      lines.push(`<li>${BLANK} split on all transactions (Inc. Buy/Sale/Pre-construction/Lease/Lease Listings/NB).</li>`);
    } else if (threshold > 0 && nextAgent) {
      const deals = `first ${threshold} Deal${threshold === 1 ? '' : 's'} (Buy/Sale/Pre-construction)`;
      lines.push(
        `<li>${agent}-${brokerage}% split for ${deals}, ${nextAgent}-${nextBrokerage}% split thereafter`
        + (lease ? ` &amp; Flat ${lease}% for Lease/Lease Listings` : '') + ';'
        + note(
          `${agent}% to Agent &amp; ${brokerage}% to Brokerage for ${deals}, ${nextAgent}% to Agent &amp; ${nextBrokerage}% to Brokerage thereafter`
          + (lease ? ` &amp; Flat ${lease}% to Agent &amp; ${pad2(complement(lease))}% to Brokerage for all Lease/Lease Listings` : '') + '.',
        )
        + '</li>',
      );
    } else {
      lines.push(
        `<li>Flat ${agent}-${brokerage}% split on all transactions (Inc. Buy/Sale/Pre-construction/Lease/Lease Listings/NB);`
        + note(`${agent}% to Agent &amp; ${brokerage}% to Brokerage.`)
        + '</li>',
      );
    }

    if (leadAgent) {
      lines.push(
        `<li>${leadAgent}-${leadBrokerage}% split on all Brokerage Leads (Buy/Sale/Pre-construction/Lease/Lease Listings/NB).`
        + note(`${leadAgent}% to Agent &amp; ${leadBrokerage}% to Brokerage; Any expenses associated with these leads will be shared in respective proportion.`)
        + '</li>',
      );
    }
    return lines.join('');
  }

  /**
   * The address the letters send an agent's banking documents to.
   *
   * Company Settings may hold two addresses separated by "&" — the general one first, the payouts
   * one second — and where it does, the second is used exactly as before. Where it holds only one,
   * that one address is the brokerage's public inbox, and the previous code took it as the accounts
   * address by default. `ACCOUNTS_EMAIL` is used instead: an agent following the letter should not
   * be sending a SIN and a void cheque to whoever reads `info@`.
   */
  private accountsEmail(setting: string | null): string {
    const parts = String(setting ?? '').split('&').map((s) => s.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : ACCOUNTS_EMAIL;
  }

  /**
   * Which of the brokerage's five agreements this agent's recorded terms correspond to, or null when
   * they correspond to none of them.
   *
   * Read from the same fields `commissionTerms()` writes from, so the label and the wording under it
   * can never describe different splits. Deliberately exact: the tiered documents are written for
   * the first TEN deals, so a threshold of eight is genuinely not one of them, and the honest answer
   * is that no standard document covers it.
   */
  private contractVariant(profile: Record<string, unknown>): string | null {
    const agent = pad2(pct(profile.agent_comm_pct));
    const brokerage = pad2(pct(profile.brok_comm_pct) || complement(agent));
    const lease = pct(profile.lease_comm_pct);
    const threshold = Math.floor(Number(profile.completed_deals) || 0);
    const nextAgent = pad2(pct(profile.upgrade_agent_pct));
    const nextBrokerage = pad2(pct(profile.upgrade_brok_pct) || complement(nextAgent));
    const leadAgent = pad2(pct(profile.brokerage_lead_pct));
    const leadBrokerage = pad2(pct(profile.brokerage_lead_brok_pct) || complement(leadAgent));

    let base: string;
    if (threshold > 0 && nextAgent) {
      // The tiered family: the first tier, the tier after it, and a flat lease rate all have to match.
      base = threshold === TIERED_THRESHOLD && lease === '95'
        && agent === '90' && brokerage === '10' && nextAgent === '95' && nextBrokerage === '05'
        ? '90-10' : '';
    } else {
      // The flat family is 95-05 and nothing else. Note what this rules out: an agent on a flat
      // 90/10 with no tier at all would otherwise spell "90-10" and be handed the name of the tiered
      // document, which promises them 95-05 after ten deals — terms they are not on.
      base = agent === '95' && brokerage === '05' ? '95-05' : '';
    }
    if (!base) return null;

    const candidate = leadAgent ? `${base} + ${leadAgent}-${leadBrokerage}` : base;
    return CONTRACT_VARIANTS.has(candidate) ? candidate : null;
  }

  /** Values every onboarding template can use, drawn from the agent and company settings. */
  private async vars(userId: number, attachmentCount = 0, baseUrl = ''): Promise<{ vars: Record<string, unknown>; to: string; name: string }> {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${userId}.` });

    const company = await this.settings.current();
    const profile = parseJsonObject(user.profile);
    // The agent's personal address is where onboarding mail belongs — their brokerage address may
    // not exist yet, which is the whole point of onboarding.
    const to = String(profile.personal_email ?? '').trim() || String(user.email ?? '').trim();
    const onboardDate = String(profile.onboard_date ?? '').trim();
    const today = new Date().toISOString().slice(0, 10);
    // The agreement is dated the day the agent joined, falling back to today for one being drawn
    // up now. Split into three because the sentence on the paper form has three blanks.
    const signed = new Date(`${onboardDate || today}T00:00:00Z`);

    return {
      to,
      name: user.name,
      vars: {
        agent_name: user.name,
        agent_email: to,
        company_name: company.name,
        // Escaped HERE, not by the renderer. These three carry the ruled blank when the detail is
        // missing, which is markup, so they are on `HTML_VARIABLES` and the renderer leaves them
        // alone — which makes escaping the typed part this service's job. An address containing
        // `&` or `<` would otherwise reach the agreement as markup.
        company_address: escapeHtml(String(company.address ?? '').trim()) || BLANK,
        agent_address: escapeHtml(String(profile.address ?? '').trim()) || BLANK,
        agent_type: this.agentType(profile),
        commission_terms: this.commissionTerms(profile),
        agreement_day: ordinal(signed.getUTCDate()),
        agreement_month: MONTHS[signed.getUTCMonth()],
        agreement_year: String(signed.getUTCFullYear()),
        // Empty rather than a stand-in phrase: the template already says "our Broker of Record",
        // so a fallback of the same words rendered it twice in the same sentence.
        broker_of_record: String(profile.broker_of_record ?? '').trim(),
        broker_email: String(profile.broker_email ?? '').trim() || String(company.email ?? '').split('&')[0].trim(),
        accounts_email: this.accountsEmail(company.email),
        onboard_date: onboardDate || today,
        contract_date: onboardDate || today,
        current_date: today,
        // How many documents actually go with this email, so the line asking the agent to confirm
        // them names the real number. Blank below two: "the 1 attached documents" is worse than
        // "the attached documents", and the sentence reads either way.
        attachment_count: attachmentCount >= 2 ? String(attachmentCount) : '',
        logo_img: this.logoImg(company, baseUrl),
        training_banner: await this.trainingBanner(),
      },
    };
  }

  /**
   * Which template this button sends for THIS agent.
   *
   * Only the onboarding guide has to ask, and it asks the record rather than the person pressing the
   * button: an agent marked Fresher receives the RECO/TREB letter and one marked Experienced receives
   * the resignation-and-transfer letter, with no way to send the wrong one by mistake. Anything else
   * — including a record onboarded before the field existed — receives the experienced letter, which
   * is what this button sent for every agent until now.
   */
  private eventKeyFor(kind: OnboardingKind, profile: Record<string, unknown>): string {
    const keys = KIND_EVENT_KEYS[kind];
    if (!keys) throw new BadRequestException({ message: `Unknown onboarding email "${kind}".` });
    if (kind !== 'onboard') return keys[0];

    const experience = String(profile.experience ?? '').trim();
    return experience === 'Fresher' ? ONBOARD_FRESHER : ONBOARD_EXPERIENCED;
  }

  /** The agent's saved profile, which decides both which letter goes and which files go with it. */
  private async agentProfile(userId: number): Promise<Record<string, unknown>> {
    const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { profile: true } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${userId}.` });
    return parseJsonObject(user.profile);
  }

  /**
   * Whether one of the template's files belongs in THIS agent's copy of the email.
   *
   * Only the two headshot sheets are addressed to part of the roster; everything else goes to
   * everyone. An agent recorded as Other, or with no gender saved at all, receives both sheets —
   * the record is the only thing consulted, and where it does not answer the question the letter
   * falls back to offering both rather than picking one on the agent's behalf.
   */
  private appliesToAgent(filename: string, gender: string): boolean {
    const belongsTo = GENDERED_DOCUMENTS[filename];
    if (!belongsTo) return true;
    if (gender !== 'Male' && gender !== 'Female') return true;
    return belongsTo === gender;
  }

  /**
   * The message exactly as it would arrive for this agent, for review before sending.
   *
   * `baseUrl` is where this API is reachable, used to point the signature logo at it.
   */
  async preview(userId: number, kind: OnboardingKind, baseUrl = ''): Promise<OnboardingPreview> {
    const profile = await this.agentProfile(userId);
    const eventKey = this.eventKeyFor(kind, profile);
    const meta = MAIL_EVENTS[eventKey];

    // Seeded on first use, exactly as the mailer does, so the template exists to be edited even
    // if nobody has opened the Templates screen yet.
    let template = await this.prisma.email_templates.findUnique({
      where: { event_key: eventKey },
      include: { mail_accounts: true, attachments: { select: { id: true, filename: true, size: true } } },
    });
    if (!template && meta) {
      const now = new Date();
      await this.prisma.email_templates.create({
        data: {
          event_key: eventKey, module: meta.module, name: meta.label,
          subject: meta.default_subject, body_html: meta.default_body_html,
          is_active: true, created_at: now, updated_at: now,
        },
      });
      template = await this.prisma.email_templates.findUnique({
        where: { event_key: eventKey },
        include: { mail_accounts: true, attachments: { select: { id: true, filename: true, size: true } } },
      });
    }
    if (!template) throw new NotFoundException({ message: `No email template for "${eventKey}".` });

    // A row still holding wording this app shipped has never been edited, so a correction reaches
    // agents without an admin re-pasting it. `updated_at` is deliberately left alone: moving it here
    // would make this the last refresh the row ever received. Once someone saves their own wording
    // in Settings → Templates, it is no longer recognised as shipped and the stored version wins.
    if (meta && (template.subject !== meta.default_subject || template.body_html !== meta.default_body_html)
      && this.isShippedWording(eventKey, template)) {
      await this.prisma.email_templates.update({
        where: { id: template.id },
        data: { subject: meta.default_subject, body_html: meta.default_body_html },
      });
      template.subject = meta.default_subject;
      template.body_html = meta.default_body_html;
    }

    // The letters that refer to documents get them the first time they are used: the experienced
    // agent's guide tells them to look at three attached files, and the Training Department's letter
    // sends the action plan behind the subjects it lists. Read after seeding, since the experienced
    // letter quotes the count in its body.
    const documents = SEEDED_DOCUMENTS[eventKey];
    if (documents && template.attachments.length === 0) {
      const added = await this.seedOnboardDocuments(template.id, documents);
      if (added) template.attachments = added;
    }

    // Narrowed to this agent BEFORE the count is taken: the sheet that is not theirs is not sent, so
    // it must not be listed on the review screen and must not be counted in the line asking them to
    // confirm how many documents arrived.
    const gender = String(profile.gender ?? '').trim();
    const attachments = template.attachments.filter((a) => this.appliesToAgent(a.filename, gender));

    // Rendered with the real attachment count, which is only known once the template is loaded.
    const { vars, to, name } = await this.vars(userId, attachments.length, baseUrl);
    const variant = kind === 'contract' ? this.contractVariant(profile) : null;
    const html = renderTemplate(template.body_html, vars);

    return {
      kind,
      event_key: eventKey,
      subject: renderTemplate(template.subject, vars),
      html,
      to,
      variables: variablesFor(eventKey),
      attachments,
      generated_document: kind === 'contract' ? documentName(name, variant)
        : kind === 'media' ? mediaDocumentName(name)
          : null,
      contract_variant: variant,
      sender: template.mail_accounts?.from_email ?? null,
      ...this.warningFor({ to, isActive: template.is_active }),
    };
  }

  /**
   * Whether this row still holds wording that came with the app, rather than something an admin
   * wrote — the question of whether it is safe to replace.
   *
   * A body matching a version this app shipped answers it outright. Failing that, a row whose
   * `updated_at` never moved from `created_at` has not been saved at all, which covers a version
   * whose hash was never recorded.
   */
  private isShippedWording(eventKey: string, template: { body_html: string; created_at: Date | null; updated_at: Date | null }): boolean {
    const hashes = SUPERSEDED_BODY_HASHES[eventKey] ?? [];
    if (hashes.length) {
      const hash = createHash('sha256').update(template.body_html, 'utf8').digest('hex');
      if (hashes.includes(hash)) return true;
    }
    return !!template.created_at && !!template.updated_at
      && template.updated_at.getTime() === template.created_at.getTime();
  }

  /**
   * The one thing worth saying before the button is pressed, most serious first — a send that
   * cannot happen, then one that will arrive incomplete.
   */
  private warningFor(s: { to: string; isActive: boolean }): Pick<OnboardingPreview, 'warning' | 'warning_kind'> {
    if (!s.to) {
      return { warning: 'This agent has no email address on file, so there is nowhere to send it.', warning_kind: 'no_recipient' };
    }
    if (!s.isActive) {
      return { warning: 'This template is switched off in Settings → Templates and will not send until it is set to Active.', warning_kind: 'template_off' };
    }
    // There is deliberately nothing here about the contract having no attachment: the agreement is
    // generated from the message and always goes with it, so the case the old warning covered can no
    // longer happen.
    return { warning: null, warning_kind: null };
  }

  /**
   * Send it. `subject` and `html` are whatever came back from the review, so an edit made there
   * is what the agent receives; omit them and the stored template is used unchanged.
   */
  async send(
    userId: number,
    kind: OnboardingKind,
    edited: { subject?: string; html?: string; attachments?: AdHocAttachment[] },
    baseUrl = '',
  ): Promise<{ message: string; to: string }> {
    const preview = await this.preview(userId, kind, baseUrl);
    if (!preview.to) throw new BadRequestException({ message: 'This agent has no email address on file.' });

    const subject = (edited.subject ?? '').trim() || preview.subject;
    const html = (edited.html ?? '').trim() || preview.html;
    if (!subject || !html) throw new BadRequestException({ message: 'The subject and message cannot be empty.' });

    // Sent as an already-rendered message rather than through the template registry, because the
    // body under review may have been edited and must not be re-rendered from the stored one. The
    // template's own sender and attachments are carried across explicitly so the agent still
    // receives the resignation sample, action plan or contract that is attached to it.
    const template = await this.prisma.email_templates.findUnique({
      where: { event_key: preview.event_key },
      select: { mail_account_id: true, attachments: { select: { id: true, filename: true, content_type: true, data: true } } },
    });

    // Exactly the files the review listed, by id rather than by name: the preview has already
    // decided which of the two headshot sheets is this agent's, and re-deciding it here would be a
    // second answer to the same question, free to disagree with the one that was on screen.
    const reviewed = new Set(preview.attachments.map((a) => a.id));
    const files: MailAttachment[] = (template?.attachments ?? []).filter((a) => reviewed.has(a.id)).map((a) => ({
      data: Buffer.from(a.data).toString('base64'),
      name: a.filename,
      mime: a.content_type,
    }));

    // Files picked in the review go out with this email only and are not stored on the template.
    // A contract agreement is usually filled in for one agent, so keeping it on the template would
    // attach that agent's copy to every future send.
    files.push(...this.adhocFiles(edited.attachments ?? []));

    // The agreement goes with it as a document, built from the same body the agent is about to read,
    // so there is something to print and sign rather than an email to scroll back through.
    if (GENERATES_DOCUMENT.includes(kind)) {
      const document = await this.agreementDocument(userId, kind, html);
      files.push({ data: document.data.toString('base64'), name: document.filename, mime: 'application/pdf' });
    }

    // The signature logo travels inside the message rather than as a link back to this API. The
    // review screen has to load it over HTTP — it is a browser — but an agent's mail client is
    // somewhere else entirely, and a URL that resolves here may resolve to nothing there.
    const embedded = await this.embedLogo(html);
    if (embedded.file) files.push(embedded.file);

    // The training banner travels the same way, and after the logo so both swaps see the body the
    // other left behind.
    const withBanner = await this.embedBanner(embedded.html);
    if (withBanner.file) files.push(withBanner.file);

    await this.mailer.sendDirect(preview.to, subject, withBanner.html, template?.mail_account_id ?? null, files, null);
    const extra = (edited.attachments ?? []).length;
    return {
      message: extra ? `Sent to ${preview.to} with ${extra} attached file${extra === 1 ? '' : 's'}.` : `Sent to ${preview.to}.`,
      to: preview.to,
    };
  }

  /**
   * The agreement as a document the agent can sign, built from the message being sent.
   *
   * Generated rather than stored: the contract is different for every agent, and one filled in for
   * somebody else is the worst possible thing to have on a template. Because it is rendered from the
   * reviewed HTML, a correction made in the dialog reaches the attachment as well as the email.
   */
  async agreementDocument(userId: number, kind: OnboardingKind, html: string): Promise<{ filename: string; data: Buffer }> {
    if (!GENERATES_DOCUMENT.includes(kind)) {
      throw new BadRequestException({ message: `No document is generated for "${kind}".` });
    }
    const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { name: true, profile: true } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${userId}.` });

    // The same renderer for both: the media agreement is the same kind of object as the contract —
    // a one-page form on the brokerage's letterhead, built from the body being sent.
    const logo = await this.logoDataUri();
    const data = await renderContractPdf(html, logo);
    return {
      filename: kind === 'media'
        ? mediaDocumentName(user.name)
        : documentName(user.name, this.contractVariant(parseJsonObject(user.profile))),
      data,
    };
  }

  /** The brand logo as a data URI for the generated document, or null when none is uploaded. */
  private async logoDataUri(): Promise<string | null> {
    const logo = await this.settings.logoFile();
    if (!logo) return null;
    try {
      const bytes = await fs.readFile(logo.abs);
      return `data:${logo.mime};base64,${bytes.toString('base64')}`;
    } catch {
      return null; // recorded but unreadable — the document is worth more than its letterhead
    }
  }

  /**
   * Swap the signature logo's URL for the image itself, carried in the message under `cid:`.
   *
   * Matched on the endpoint rather than the whole URL because the body being sent is whatever came
   * back from the review, where the host is this API's own address — and an admin may have edited
   * the message around it. If the file is missing from disk the URL is left as it stands: it is a
   * long shot, but a better one than an <img> pointing at nothing at all.
   */
  private async embedLogo(html: string): Promise<{ html: string; file: MailAttachment | null }> {
    if (!LOGO_SRC.test(html)) return { html, file: null };

    const logo = await this.settings.logoFile();
    if (!logo) return { html, file: null };
    try {
      const data = await fs.readFile(logo.abs);
      return {
        html: html.replace(LOGO_SRC, `src="cid:${LOGO_CID}"`),
        file: { data: data.toString('base64'), name: `logo${path.extname(logo.abs) || '.png'}`, mime: logo.mime, cid: LOGO_CID },
      };
    } catch {
      return { html, file: null };
    }
  }

  /**
   * One of the files that will be sent, so it can be read in the review screen before it goes.
   *
   * Addressed by the kind of email rather than by template id: the screen already knows which email
   * it is reviewing, and looking the template up here means there is no id to pass around and get
   * out of step, and no way to read a file off some other template through this route.
   */
  async attachment(kind: OnboardingKind, attachmentId: number): Promise<{ filename: string; contentType: string; data: Buffer }> {
    const eventKeys = KIND_EVENT_KEYS[kind];
    if (!eventKeys) throw new BadRequestException({ message: `Unknown onboarding email "${kind}".` });

    // Either onboarding guide, since this route has no agent to decide between them — but still only
    // the templates this button sends, so no other template's files are reachable through it.
    const row = await this.prisma.email_template_attachments.findFirst({
      where: { id: attachmentId, template: { event_key: { in: eventKeys } } },
    });
    if (!row) throw new NotFoundException({ message: 'That file is no longer attached to this email.' });
    return { filename: row.filename, contentType: row.content_type, data: Buffer.from(row.data) };
  }

  /**
   * Put a template's shipped documents on it the first time it is used — the resignation-letter
   * sample the onboarding guide tells the agent to find attached, the sample headshots they pick a
   * business-card style from, and the 30-day action plan that both Recruitment and Training send.
   *
   * They ship with the server rather than being pasted into a migration, so replacing one is
   * dropping a new file in `assets/onboarding`. Only ever done when the template carries no files
   * at all, so an office that curates its own set keeps it — and one that removes a document keeps
   * the remaining ones rather than having the default set restored underneath them.
   *
   * Best-effort: a missing or unreadable file leaves the email to go out without it, which is far
   * better than a review screen that will not open.
   */
  private async seedOnboardDocuments(templateId: number, filenames: string[]): Promise<{ id: number; filename: string; size: number }[] | null> {
    const now = new Date();
    let added = false;

    for (const filename of filenames) {
      try {
        /*
         * The name in the inbox and the name on disk are not always the same. The banner is stored
         * under a developer's filename and has to arrive under a reader's one, so the source is
         * resolved separately from the name the attachment is given.
         */
        const source = filename === TRAINING_BANNER_DOC
          ? (await this.bannerFile())?.abs
          : path.join(ONBOARD_DOC_DIR, filename);
        if (!source) continue; // no artwork installed — the letter still reads correctly without it
        const data = await fs.readFile(source);
        await this.prisma.email_template_attachments.create({
          data: {
            template_id: templateId,
            filename,
            // Was hardcoded to application/pdf, which was true of every seeded document until this
            // one. A JPEG announced as a PDF is a file the recipient's machine refuses to open.
            content_type: contentTypeFor(filename),
            size: data.length,
            data: new Uint8Array(data),
            created_at: now,
          },
        });
        added = true;
      } catch {
        // Skipped — see above.
      }
    }
    if (!added) return null;

    return this.prisma.email_template_attachments.findMany({
      where: { template_id: templateId },
      select: { id: true, filename: true, size: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Decode and check the files picked in the review, before anything is sent. */
  private adhocFiles(input: AdHocAttachment[]): { data: string; name: string; mime: string }[] {
    if (!input.length) return [];
    if (input.length > MAX_ADHOC_FILES) {
      throw new BadRequestException({ message: `Attach at most ${MAX_ADHOC_FILES} files to one email.` });
    }

    let total = 0;
    return input.map((a) => {
      const name = String(a.filename ?? '').trim() || 'attachment';
      const base64 = String(a.data ?? '').replace(/^data:[^;]+;base64,/, '');
      if (!base64) throw new BadRequestException({ message: `"${name}" is empty.` });

      let bytes: number;
      try { bytes = Buffer.from(base64, 'base64').length; }
      catch { throw new BadRequestException({ message: `"${name}" could not be read.` }); }
      if (!bytes) throw new BadRequestException({ message: `"${name}" is empty.` });

      total += bytes;
      if (total > MAX_ADHOC_BYTES) {
        const mb = (MAX_ADHOC_BYTES / 1024 / 1024).toFixed(0);
        throw new BadRequestException({
          message: `Attachments total ${(total / 1024 / 1024).toFixed(1)} MB, above the ${mb} MB limit — most mail servers would reject the message.`,
        });
      }
      return { data: base64, name: name.slice(0, 255), mime: String(a.content_type ?? '').trim() || 'application/octet-stream' };
    });
  }
}
