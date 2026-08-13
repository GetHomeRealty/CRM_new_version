import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CAMPAIGN_CATEGORIES } from './campaign.constants';
import type { AuthUserRecord } from '../auth/auth.types';

import { isAgent } from '../core/authz';
const str = (v: unknown): string => String(v ?? '').trim();
const isCategory = (v: string): boolean => CAMPAIGN_CATEGORIES.some((c) => c.value === v);

/** Total attachment bytes per template. SMTP providers reject oversized messages outright. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TEMPLATE = 5;

export interface TemplateInput {
  name?: unknown;
  subject?: unknown;
  content?: unknown;
  category?: unknown;
  is_active?: unknown;
}

/**
 * The Campaigns module's own template library.
 *
 * Separate from Email Settings' `email_templates`: those are transactional, keyed by event and
 * fired by the system. These are marketing content an agent writes and reuses.
 */
@Injectable()
export class CampaignTemplatesService {
  constructor(private readonly prisma: PrismaService, private readonly audience: CampaignAudienceService) {}

  /**
   * Who may see which templates.
   *
   * A template with no `user_id` is one of the six the application ships with — everybody's, and
   * only an administrator's to change. Anything else belongs to the person who wrote it, and is
   * private to them **whatever the viewer's role**.
   *
   * THAT INCLUDES SUPER ADMIN, and it is a deliberate exception to how the rest of this application
   * works. Both this and `assertEditable` used to begin `if (!isAgent(user)) return {}` — so every
   * non-agent role saw and could edit every agent's private drafts. Measured during the CRM audit: a
   * Super Admin renamed an agent-owned template and got a 200.
   *
   * The brokerage's decision is that an agent's own campaign drafts stay theirs. A Super Admin still
   * administers everything else — the built-ins, the campaigns, the suppression list — but a
   * half-written template an agent has not sent is not administration, it is their working notes.
   */
  private visibleWhere(user: AuthUserRecord): Record<string, unknown> {
    return { OR: [{ user_id: null }, { user_id: user.id ?? -1 }] };
  }

  /**
   * Refuse to change a template that is not this person's to change.
   *
   * Two separate rules, and they point in opposite directions for the two kinds of template:
   *
   *   · A BUILT-IN (`user_id` null) is shared, so an agent may not edit it — one agent's change
   *     would rewrite what every other agent starts from. An administrator may, because maintaining
   *     the shared set is administration.
   *   · SOMEBODY ELSE'S is refused to everyone, administrators included. In practice `visibleWhere`
   *     means such a template is never even found, so this is the second lock rather than the first.
   */
  private assertEditable(t: { id: number; user_id: number | null; name: string }, user: AuthUserRecord): void {
    if (t.user_id === null) {
      if (isAgent(user)) {
        throw new ForbiddenException({
          message: `"${t.name}" is one of the built-in templates. Duplicate it to make a version you can change.`,
        });
      }
      return;
    }
    if (t.user_id !== (user.id ?? -1)) {
      throw new ForbiddenException({ message: 'This template belongs to somebody else.' });
    }
  }


  async list(category: string | undefined, user: AuthUserRecord): Promise<Record<string, unknown>[]> {
    const where: Record<string, unknown> = { deleted_at: null, ...this.visibleWhere(user) };
    const cat = str(category);
    if (cat && cat !== 'all' && isCategory(cat)) where.category = cat;

    const rows = await this.prisma.campaign_templates.findMany({
      where,
      include: { attachments: { select: { id: true, filename: true, content_type: true, size: true } } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return rows.map((t) => this.present(t));
  }

  async get(id: number, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const t = await this.prisma.campaign_templates.findFirst({
      where: { id, deleted_at: null, ...this.visibleWhere(user) },
      include: { attachments: { select: { id: true, filename: true, content_type: true, size: true } } },
    });
    if (!t) throw new NotFoundException({ message: 'Template not found.' });
    return { ...this.present(t), content: t.content };
  }

  async create(input: TemplateInput, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const data = this.validate(input, true);
    const now = new Date();
    const t = await this.prisma.campaign_templates.create({
      data: {
        ...data,
        name: data.name as string,
        subject: data.subject as string,
        content: data.content as string,
        created_by: user.name,
        user_id: user.id ?? null,
        created_at: now,
        updated_at: now,
      },
      include: { attachments: true },
    });
    return this.present(t);
  }

  async update(id: number, input: TemplateInput, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const existing = await this.prisma.campaign_templates.findFirst({ where: { id, deleted_at: null, ...this.visibleWhere(user) } });
    if (!existing) throw new NotFoundException({ message: 'Template not found.' });
    this.assertEditable(existing, user);

    const data = this.validate(input, false);
    const t = await this.prisma.campaign_templates.update({
      where: { id },
      data: { ...data, updated_at: new Date() },
      include: { attachments: { select: { id: true, filename: true, content_type: true, size: true } } },
    });
    return this.present(t);
  }

  /**
   * Soft delete. Campaigns store a snapshot of the subject and body they sent, so removing a
   * template never rewrites the history of a campaign that used it.
   */
  async remove(id: number, user: AuthUserRecord): Promise<{ deleted: boolean; used_by: number }> {
    const existing = await this.prisma.campaign_templates.findFirst({ where: { id, deleted_at: null, ...this.visibleWhere(user) } });
    if (!existing) throw new NotFoundException({ message: 'Template not found.' });
    this.assertEditable(existing, user);
    const usedBy = await this.prisma.campaigns.count({ where: { template_id: id } });
    await this.prisma.campaign_templates.update({ where: { id }, data: { deleted_at: new Date(), updated_at: new Date() } });
    return { deleted: true, used_by: usedBy };
  }

  // ----------------------------------------------------------- attachments
  /**
   * THE THREE METHODS BELOW TOOK NO `user` AT ALL, AND THE CONTROLLER PASSED NONE.
   *
   * `get`, `update` and `remove` each go through `visibleWhere(user)` and `assertEditable`, which is
   * what makes an agent's drafts theirs — the brokerage's explicit decision, recorded on
   * `visibleWhere`: *a Super Admin must not see or edit an agent's custom campaign templates.* The
   * attachment routes were not part of that change and were reachable by anyone holding
   * `campaigns: view` (download) or `campaigns: edit` (add, remove), given two integer ids.
   *
   * The write side is the worse half. An attachment rides along with EVERY send of its template, so
   * planting one is not "editing somebody's draft" — it is putting a file in front of the
   * brokerage's clients over that agent's name; and removing one silently strips a document from
   * sends that person believes still carry it.
   *
   * Same two locks, same wording, so a private template and its files answer identically: "not
   * found" for something that is not yours, and the built-in rule for the shared six.
   */

  /** Store a file that will ride along with every send of this template. */
  async addAttachment(templateId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const template = await this.prisma.campaign_templates.findFirst({
      where: { id: templateId, deleted_at: null, ...this.visibleWhere(user) },
      include: { attachments: { select: { id: true, size: true } } },
    });
    if (!template) throw new NotFoundException({ message: 'Template not found.' });
    this.assertEditable(template, user);

    const filename = str(body.filename) || 'attachment';
    const contentType = str(body.content_type) || 'application/octet-stream';
    // Accept either a bare base64 string or a full data: URI from a file input.
    const base64 = str(body.data).replace(/^data:[^;]+;base64,/, '');
    if (!base64) throw new BadRequestException({ message: 'The file is empty.' });

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      throw new BadRequestException({ message: 'That file could not be read.' });
    }
    if (buffer.length === 0) throw new BadRequestException({ message: 'The file is empty.' });

    if (template.attachments.length >= MAX_ATTACHMENTS_PER_TEMPLATE) {
      throw new BadRequestException({ message: `A template can carry at most ${MAX_ATTACHMENTS_PER_TEMPLATE} attachments.` });
    }
    const totalAfter = template.attachments.reduce((sum, a) => sum + a.size, 0) + buffer.length;
    if (totalAfter > MAX_ATTACHMENT_BYTES) {
      const mb = (MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0);
      throw new BadRequestException({ message: `Attachments would total ${(totalAfter / 1024 / 1024).toFixed(1)} MB, above the ${mb} MB limit — most mail servers would reject the message.` });
    }

    const row = await this.prisma.campaign_template_attachments.create({
      data: {
        template_id: templateId,
        filename: filename.slice(0, 255),
        content_type: contentType.slice(0, 128),
        size: buffer.length,
        // Prisma's Bytes maps to Uint8Array; a Node Buffer's backing store may be a
        // SharedArrayBuffer, which the generated type rejects. Copy into a plain view.
        data: new Uint8Array(buffer),
        created_at: new Date(),
      },
      select: { id: true, filename: true, content_type: true, size: true },
    });
    return row;
  }

  async removeAttachment(templateId: number, attachmentId: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    // A delete, so both locks — the same pair `remove()` applies to the template itself.
    const template = await this.prisma.campaign_templates.findFirst({
      where: { id: templateId, deleted_at: null, ...this.visibleWhere(user) },
      select: { id: true, user_id: true, name: true },
    });
    if (!template) throw new NotFoundException({ message: 'Attachment not found.' });
    this.assertEditable(template, user);

    const row = await this.prisma.campaign_template_attachments.findFirst({
      where: { id: attachmentId, template_id: templateId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ message: 'Attachment not found.' });
    await this.prisma.campaign_template_attachments.delete({ where: { id: attachmentId } });
    return { deleted: true };
  }

  async getAttachment(templateId: number, attachmentId: number, user: AuthUserRecord): Promise<{ filename: string; content_type: string; data: Buffer }> {
    // The template first: the file is only reachable if its template is. `visibleWhere` — not
    // `assertEditable` — because reading a built-in's attachment is legitimate for everyone, exactly
    // as reading the built-in itself is.
    const template = await this.prisma.campaign_templates.findFirst({
      where: { id: templateId, deleted_at: null, ...this.visibleWhere(user) },
      select: { id: true },
    });
    // "Attachment not found", not "template not found", so the reply is the same whether the
    // template is somebody else's or the attachment id is invented.
    if (!template) throw new NotFoundException({ message: 'Attachment not found.' });

    const row = await this.prisma.campaign_template_attachments.findFirst({ where: { id: attachmentId, template_id: templateId } });
    if (!row) throw new NotFoundException({ message: 'Attachment not found.' });
    return { filename: row.filename, content_type: row.content_type, data: Buffer.from(row.data) };
  }

  /**
   * Attachments for a send, in the shape the mailer wants. A template with none returns an
   * empty list, so the caller never needs to special-case it.
   */
  async attachmentsForSend(templateId: number): Promise<{ data: string; name: string; mime: string }[]> {
    const rows = await this.prisma.campaign_template_attachments.findMany({ where: { template_id: templateId } });
    return rows.map((a) => ({
      data: Buffer.from(a.data).toString('base64'),
      name: a.filename,
      mime: a.content_type,
    }));
  }

  // ------------------------------------------------------------ validation
  private validate(input: TemplateInput, requireCore: boolean): Record<string, unknown> {
    const errors: Record<string, string[]> = {};
    const add = (f: string, m: string) => { (errors[f] ??= []).push(m); };
    const out: Record<string, unknown> = {};
    const has = (k: keyof TemplateInput) => input[k] !== undefined;

    if (requireCore || has('name')) {
      const name = str(input.name);
      if (!name) add('name', 'A template name is required.');
      else if (name.length > 255) add('name', 'The name must be 255 characters or fewer.');
      else out.name = name;
    }

    if (requireCore || has('subject')) {
      const subject = str(input.subject);
      if (!subject) add('subject', 'A subject line is required.');
      else if (subject.length > 500) add('subject', 'The subject must be 500 characters or fewer.');
      else out.subject = subject;
    }

    if (requireCore || has('content')) {
      const content = str(input.content);
      if (!content) add('content', 'The email body cannot be empty.');
      else if (content.length > 200000) add('content', 'The body must be 200,000 characters or fewer.');
      else out.content = content;
    }

    if (requireCore || has('category')) {
      const category = str(input.category) || 'custom';
      if (!isCategory(category)) add('category', `The category must be one of: ${CAMPAIGN_CATEGORIES.map((c) => c.value).join(', ')}.`);
      else out.category = category;
    }

    if (has('is_active')) out.is_active = input.is_active === true || input.is_active === 'true';

    if (Object.keys(errors).length) {
      const first = Object.values(errors)[0][0];
      const count = Object.values(errors).reduce((a, v) => a + v.length, 0);
      throw new BadRequestException({
        message: count > 1 ? `${first} (and ${count - 1} more error${count - 1 === 1 ? '' : 's'})` : first,
        errors,
      });
    }
    return out;
  }

  private present(t: Record<string, unknown>): Record<string, unknown> {
    const attachments = (t.attachments ?? []) as { id: number; filename: string; content_type: string; size: number }[];
    return {
      id: t.id,
      name: t.name,
      subject: t.subject,
      category: t.category,
      is_active: t.is_active,
      // The list carries the full body too: the campaigns UI renders a live thumbnail and a preview
      // of each template straight from the list response, so an omitted body shows up as a blank card.
      content: t.content ?? '',
      // Extracted rather than stored: the tokens are whatever the body currently contains, so a
      // stored list would drift the moment someone edits the content.
      variables: this.audience.extractTokens(String(t.subject ?? ''), String(t.content ?? '')),
      attachments,
      attachment_count: attachments.length,
      created_by: t.created_by,
      created_at: t.created_at instanceof Date ? t.created_at.toISOString() : null,
      updated_at: t.updated_at instanceof Date ? t.updated_at.toISOString() : null,
    };
  }
}
