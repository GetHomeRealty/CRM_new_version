import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isSuperAdmin } from '../core/authz';
import { throwValidation } from '../common/laravel-exceptions';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * INDIA INVOICING SETTINGS (19 Oct 2026).
 *
 * What the India invoice prints that is not on the deal: the company (Get Home Realty Pvt Ltd - CIN,
 * phone, email), our two offices (address, state, GSTIN), the bank details box, the SAC code, the
 * invoice prefix and terms. Taken from the brokerage's two invoice templates (Hyderabad and
 * Vizianagaram); the bank details are left for a Super Admin to type in (Sai: "yes", type them once).
 * Kept on the one company_settings row as JSON, so nothing about Canada's settings changes.
 */
export interface IndiaOffice { key: string; name: string; address: string; state: string; gstin: string }
export interface IndiaSettings {
  company_name: string; cin: string; phone: string; email: string;
  sac_code: string; invoice_prefix: string; terms: string;
  bank: { beneficiary: string; bank_name: string; account_number: string; ifsc: string };
  offices: IndiaOffice[];
  default_office: string;
}

export const INDIA_DEFAULTS: IndiaSettings = {
  company_name: 'GET HOME REALTY PRIVATE LIMITED',
  cin: 'U68200AP2024FTC115697',
  phone: '9963206933',
  email: 'gethomerealtyindia@gmail.com',
  // Real estate services on a fee/commission basis. Sai to confirm with the accounting team.
  sac_code: '997222',
  invoice_prefix: 'GHR',
  terms: 'Due on Receipt',
  bank: { beneficiary: 'GET HOME REALTY PRIVATE LIMITED', bank_name: '', account_number: '', ifsc: '' },
  offices: [
    { key: 'HYD', name: 'Hyderabad', address: '8-3-167/D/195, Kalyan Nagar, Phase 1, Sridevi Plaza, Flat -103, Hyderabad, Telangana - 500038', state: 'Telangana', gstin: '' },
    { key: 'VZM', name: 'Vizianagaram', address: '8-30-15/2, Plot no: 15, First Floor, Shiridi Sai Colony, Opposite Venkata Padma Vihar, Thotapalem, Kanapaka, Vizianagaram, Andhra Pradesh - 535003', state: 'Andhra Pradesh', gstin: '37AALCG4379G1Z6' },
  ],
  default_office: 'HYD',
};

const str = (v: unknown, max = 500): string => String(v ?? '').trim().slice(0, max);

@Injectable()
export class IndiaSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The saved settings over the defaults, so a field never saved still prints something sensible. */
  async get(): Promise<IndiaSettings> {
    const row = await this.prisma.company_settings.findUnique({ where: { id: 1 }, select: { india_settings: true } });
    const saved = (row?.india_settings ?? {}) as Partial<IndiaSettings>;
    const offices = Array.isArray(saved.offices) && saved.offices.length ? saved.offices : INDIA_DEFAULTS.offices;
    return { ...INDIA_DEFAULTS, ...saved, bank: { ...INDIA_DEFAULTS.bank, ...(saved.bank ?? {}) }, offices };
  }

  office(s: IndiaSettings, key: string | null | undefined): IndiaOffice {
    return s.offices.find((o) => o.key === key) ?? s.offices.find((o) => o.key === s.default_office) ?? s.offices[0];
  }

  async update(user: AuthUserRecord | null | undefined, body: Record<string, unknown>): Promise<IndiaSettings> {
    if (!isSuperAdmin(user)) throw new ForbiddenException({ message: 'Only a Super Admin can change the India settings.' });
    const cur = await this.get();
    const b = (body.bank ?? {}) as Record<string, unknown>;
    const offices = Array.isArray(body.offices)
      ? (body.offices as Record<string, unknown>[]).map((o, i) => ({
        key: str(o.key, 8) || cur.offices[i]?.key || `O${i + 1}`,
        name: str(o.name, 64), address: str(o.address, 1000), state: str(o.state, 64), gstin: str(o.gstin, 32).toUpperCase(),
      }))
      : cur.offices;
    if (offices.some((o) => !o.name || !o.state)) throwValidation({ offices: ['Each office needs a name and a state.'] });
    const next: IndiaSettings = {
      company_name: str(body.company_name ?? cur.company_name, 255),
      cin: str(body.cin ?? cur.cin, 64), phone: str(body.phone ?? cur.phone, 64), email: str(body.email ?? cur.email, 255),
      sac_code: str(body.sac_code ?? cur.sac_code, 16), invoice_prefix: str(body.invoice_prefix ?? cur.invoice_prefix, 16) || 'GHR',
      terms: str(body.terms ?? cur.terms, 64) || 'Due on Receipt',
      bank: {
        beneficiary: str(b.beneficiary ?? cur.bank.beneficiary, 255), bank_name: str(b.bank_name ?? cur.bank.bank_name, 255),
        account_number: str(b.account_number ?? cur.bank.account_number, 64), ifsc: str(b.ifsc ?? cur.bank.ifsc, 32).toUpperCase(),
      },
      offices,
      default_office: offices.some((o) => o.key === body.default_office) ? String(body.default_office) : cur.default_office,
    };
    await this.prisma.company_settings.update({ where: { id: 1 }, data: { india_settings: next as unknown as Prisma.InputJsonValue, updated_at: new Date() } });
    return next;
  }
}
