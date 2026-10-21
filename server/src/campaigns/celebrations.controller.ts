import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { MailAccountService } from '../email/mail-account.service';
import { hasBrokerageLeadScope } from '../common/lead-scope';
import { CampaignsService, publicBaseUrlProblem } from './campaigns.service';
import { trackingBaseUrl } from './campaigns.controller';
import { LEAD_STATUS, LEAD_TYPE, LEAD_SOURCE, CLIENT_TYPE } from './campaign.constants';
import { CelebrationCampaignsService } from './celebration-campaigns.service';
import { CelebrationAutomationService } from './celebration-automation.service';
import { CelebrationAiService, celebrationAiStatus } from './celebration-ai.service';
import { BRAND_COLOURS, CelebrationFlyerService, FLYER_FORMATS, FLYER_STYLES, type FlyerTemplateInput } from './celebration-flyer.service';
import {
  CELEBRATION_MAX_RECIPIENTS, CELEBRATION_TOKENS, DEFAULT_TIMEZONE, FEB29_RULES, FESTIVALS, LENGTHS, TONES,
  isOccasion, occasionLabel, starterMessage,
} from './celebration';

const str = (v: unknown): string => String(v ?? '').trim();

/** Languages offered for AI writing. Free text is accepted too; this is a convenience list. */
const LANGUAGES = ['English', 'French', 'Punjabi', 'Hindi', 'Gujarati', 'Urdu', 'Tamil', 'Telugu', 'Bengali', 'Mandarin', 'Cantonese', 'Tagalog', 'Spanish', 'Portuguese', 'Arabic', 'Farsi', 'Korean', 'Vietnamese', 'Italian'];

/**
 * Campaigns → Celebrations. Viewing needs `campaigns` view; anything that saves, uploads, generates
 * or sends needs `campaigns` edit — the same split as the rest of Campaigns.
 *
 * Registered BEFORE `CampaignsController`, whose greedy `campaigns/:id` would otherwise capture
 * `campaigns/celebrations` and reject it as a non-numeric id.
 */
@Controller('campaigns/celebrations')
@UseGuards(AuthGuard, ScreenGuard)
export class CelebrationsController {
  constructor(
    private readonly celebrations: CelebrationCampaignsService,
    private readonly automations: CelebrationAutomationService,
    private readonly ai: CelebrationAiService,
    private readonly flyers: CelebrationFlyerService,
    private readonly campaigns: CampaignsService,
    private readonly accounts: MailAccountService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('options')
  @Screen('campaigns', 'view')
  async options(@CurrentUser() user: AuthUserRecord, @Req() req: Request): Promise<Record<string, unknown>> {
    const brokerage = hasBrokerageLeadScope(user);
    const agents = brokerage
      ? await this.prisma.users.findMany({ where: { status: 'Active' }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 })
      : [{ id: user.id, name: user.name }];
    const logo = await this.flyers.logoDataUri();
    return {
      occasions: [
        ...FESTIVALS,
        { value: 'custom-festival', label: 'Other festival or holiday (name it)', group: 'festival' },
        { value: 'birthday', label: 'Birthday', group: 'birthday' },
        { value: 'anniversary', label: 'Anniversary', group: 'anniversary' },
        { value: 'general', label: 'General / custom occasion (name it)', group: 'general' },
      ],
      tones: TONES, lengths: LENGTHS, languages: LANGUAGES, feb29_rules: FEB29_RULES,
      tokens: CELEBRATION_TOKENS,
      filters: {
        lead_status: LEAD_STATUS, lead_source: LEAD_SOURCE, lead_type: LEAD_TYPE, client_type: CLIENT_TYPE,
        tags: await this.campaigns.leadTags(user), agents,
      },
      scope: brokerage ? 'brokerage' : 'own',
      scope_note: brokerage
        ? 'All eligible leads means the brokerage’s shared leads plus your own — never another agent’s private book.'
        : 'All eligible leads means the leads you own, are assigned or collaborate on, and your team’s leads.',
      sender_accounts: (await this.accounts.sendersForCrm(user.id ?? null))
        .map((a) => ({ id: a.id, name: a.name, from_email: a.from_email, from_name: a.from_name })),
      default_sender: await this.campaigns.senderEmail(user),
      me: { name: user.name, email: user.email },
      ai: celebrationAiStatus(),
      flyer: {
        formats: Object.entries(FLYER_FORMATS).map(([value, f]) => ({ value, label: f.label })),
        styles: FLYER_STYLES, brand_colours: BRAND_COLOURS,
        logo_available: !!logo,
        agent_photo_available: false,
        agent_photo_note: 'Agent photos are not stored in the CRM yet, so flyers use the logo or the brokerage wordmark.',
        image_generation: false,
        image_generation_note: 'No image-generation service is connected. Flyers are drawn from an editable branded template (not AI) or uploaded.',
      },
      max_recipients: CELEBRATION_MAX_RECIPIENTS,
      default_timezone: DEFAULT_TIMEZONE,
      send_problem: publicBaseUrlProblem(trackingBaseUrl(req)),
    };
  }

  @Get()
  @Screen('campaigns', 'view')
  list(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.celebrations.list(user);
  }

  @Post()
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.celebrations.create(body, user);
  }

  /** Who would receive it and who is excluded, and why. Sends nothing. */
  @Post('audience')
  @HttpCode(200)
  @Screen('campaigns', 'view')
  audience(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.celebrations.audiencePreview(body, user);
  }

  @Get('leads')
  @Screen('campaigns', 'view')
  leads(@CurrentUser() user: AuthUserRecord, @Query('search') search?: string): Promise<unknown> {
    return this.celebrations.searchLeads(search ?? '', user);
  }

  /** The message as one recipient would see it. Creates nothing, sends nothing. */
  @Post('preview')
  @HttpCode(200)
  @Screen('campaigns', 'view')
  preview(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Req() req: Request): Promise<unknown> {
    return this.celebrations.preview(body, user, trackingBaseUrl(req));
  }

  /** A suggested message to start from — not AI, offered whether or not AI is available. */
  @Post('starter')
  @HttpCode(200)
  @Screen('campaigns', 'view')
  starter(@Body() body: Record<string, unknown>): Record<string, unknown> {
    const occasion = isOccasion(str(body.occasion)) ? str(body.occasion) : 'general';
    return { ...starterMessage(occasion, occasionLabel(occasion, str(body.occasion_label))), source: 'starter' };
  }

  /** Draft (or revise) a greeting with AI. Writes only — nothing is saved or sent. */
  @Post('ai-draft')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  aiDraft(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.ai.draft({
      occasion: str(body.occasion), occasion_label: str(body.occasion_label), instructions: str(body.instructions),
      tone: str(body.tone), length: str(body.length), language: str(body.language), branding: str(body.branding),
      previous: (body.previous && typeof body.previous === 'object' ? body.previous : null) as never,
      revision: str(body.revision),
    }, user);
  }

  // ------------------------------------------------------------------------------------ flyers
  @Post('flyers/upload')
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  async uploadFlyer(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.flyers.present(await this.flyers.upload(str(body.data), str(body.alt_text), user));
  }

  @Post('flyers/template')
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  async templateFlyer(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    const colors = (body.colors && typeof body.colors === 'object' ? body.colors : {}) as FlyerTemplateInput['colors'];
    return this.flyers.present(await this.flyers.renderTemplate({
      occasion: str(body.occasion), occasion_label: str(body.occasion_label), headline: str(body.headline).slice(0, 60),
      greeting: str(body.greeting).slice(0, 200), style: str(body.style), format: str(body.format), colors,
      include_logo: body.include_logo !== false, sender_line: str(body.sender_line).slice(0, 80), alt_text: str(body.alt_text),
    }, user));
  }

  @Get('flyers/:id')
  @Screen('campaigns', 'view')
  async flyer(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.flyers.present(await this.flyers.mine(id, user));
  }

  @Patch('flyers/:id')
  @Screen('campaigns', 'edit')
  async flyerAlt(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.flyers.present(await this.flyers.updateAlt(id, str(body.alt_text), user));
  }

  // ------------------------------------------------------------------------------- automations
  @Get('automations')
  @Screen('campaigns', 'view')
  automationList(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.automations.list(user);
  }

  @Post('automations')
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  automationCreate(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.automations.create(body, user);
  }

  @Put('automations/:id')
  @Screen('campaigns', 'edit')
  automationUpdate(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.automations.update(id, body, user);
  }

  @Delete('automations/:id')
  @Screen('campaigns', 'edit')
  automationDelete(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.automations.remove(id, user);
  }

  @Post('automations/:id/activate')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  automationActivate(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.automations.setStatus(id, 'active', body.confirm === true, user);
  }

  @Post('automations/:id/pause')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  automationPause(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.automations.setStatus(id, 'paused', false, user);
  }

  /** Who a rule would greet on a date. Sends nothing. */
  @Post('automations/:id/dry-run')
  @HttpCode(200)
  @Screen('campaigns', 'view')
  automationDryRun(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.automations.dryRun(id, str(body.date), user);
  }

  // ------------------------------------------------------------------- one celebration (keep last)
  @Get(':id')
  @Screen('campaigns', 'view')
  get(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.celebrations.get(id, user);
  }

  @Put(':id')
  @Screen('campaigns', 'edit')
  update(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.celebrations.update(id, body, user);
  }

  @Delete(':id')
  @Screen('campaigns', 'edit')
  remove(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.celebrations.remove(id, user);
  }

  @Post(':id/test')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  test(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>, @Req() req: Request): Promise<unknown> {
    return this.celebrations.testSend(id, body, user, trackingBaseUrl(req));
  }

  /** Send now or schedule. The only route in this controller that sends to recipients. */
  @Post(':id/send')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  send(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>, @Req() req: Request): Promise<unknown> {
    return this.celebrations.send(id, body, user, trackingBaseUrl(req));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  cancel(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.celebrations.cancel(id, user);
  }

  @Post(':id/retry-failed')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  retry(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.celebrations.retryFailed(id, user);
  }
}
