import { Injectable } from '@nestjs/common';
import { Prisma, type company_settings } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { decimalCast, jsonField, laravelJsonDate, phpBlank } from '../common/serialize';
import type { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';

/** Canonical company details — mirrors CompanySetting::defaults(). */
const DEFAULTS: Record<string, string | number> = {
  name: 'GetHomeRealty INC',
  address: 'UNIT-101, 218 Export Blvd, Mississauga, L5S 0A7, Ontario, Canada',
  phone: '905-565-9933',
  email: 'info@GetHomeRealty.ca & Commissionpayouts@gethomerealty.ca',
  hst_number: '786493262RT0001',
  bank_beneficiary: 'GET HOME REALTY INC',
  bank_name: 'TD',
  transit_no: '21222',
  account_no: '5086185',
  institution_no: '004',
  currency: 'CAD',
  default_tax_rate: 13,
  invoice_prefix: 'INV-',
  default_terms: 'Due on Receipt',
  thank_you_note: 'Thank you for the payment. You just made our day.',
  deposit_heading: 'Beneficiary Bank Account Detail:',
};

@Injectable()
export class CompanySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** CompanySettingController::update — save present fields, audit, return the model. */
  async update(user: ActingUser | null, dto: UpdateCompanySettingsDto): Promise<company_settings> {
    await this.current(); // ensure the row exists (+ self-heal blanks) first
    // Only fields actually present in the request are saved (matches validated()).
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) if (v !== undefined) data[k] = v;
    data.updated_at = new Date();

    const s = await this.prisma.company_settings.update({
      where: { id: 1 },
      data: data as Prisma.company_settingsUpdateInput,
    });
    await this.audit.logModule(user, 'Settings', {
      section: 'Company Settings',
      field: 'Company Settings',
      action: 'Settings updated',
      details: dto.name ?? null,
    });
    return s;
  }

  /** CompanySetting::current() — firstOrCreate(id=1) then self-heal blank fields. */
  async current(): Promise<company_settings> {
    let s = await this.prisma.company_settings.findUnique({ where: { id: 1 } });
    if (!s) s = await this.prisma.company_settings.create({ data: { id: 1 } });

    const fill: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (phpBlank((s as Record<string, unknown>)[key])) fill[key] = value;
    }
    if (Object.keys(fill).length > 0) {
      s = await this.prisma.company_settings.update({ where: { id: 1 }, data: fill });
    }
    return s;
  }

  /** Serialize the model to JSON exactly as Laravel does (column order + casts). */
  serialize(s: company_settings): Record<string, unknown> {
    return {
      id: s.id,
      feature_flags: jsonField(s.feature_flags),
      name: s.name,
      address: s.address,
      phone: s.phone,
      email: s.email,
      logo_path: s.logo_path,
      hst_number: s.hst_number,
      bank_beneficiary: s.bank_beneficiary,
      bank_name: s.bank_name,
      transit_no: s.transit_no,
      account_no: s.account_no,
      institution_no: s.institution_no,
      currency: s.currency,
      default_tax_rate: decimalCast(s.default_tax_rate, 2),
      invoice_prefix: s.invoice_prefix,
      next_invoice_no: s.next_invoice_no,
      default_terms: s.default_terms,
      thank_you_note: s.thank_you_note,
      deposit_heading: s.deposit_heading,
      created_at: laravelJsonDate(s.created_at),
      updated_at: laravelJsonDate(s.updated_at),
    };
  }
}
