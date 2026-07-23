import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LawyerSuggestion {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}
export interface BrokerageSuggestion {
  name: string | null;
  address: string | null;
  email: string | null;
  invoice_email: string | null;
  agent_email: string | null;
  phone: string | null;
}

@Injectable()
export class SuggestionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Keep the first (newest) mapped row per case-insensitive key value. */
  private dedupe<TRow, TOut>(rows: TRow[], keyOf: (r: TRow) => string | null, map: (r: TRow) => TOut): TOut[] {
    const seen = new Set<string>();
    const out: TOut[] = [];
    for (const row of rows) {
      const key = (keyOf(row) ?? '').trim().toLowerCase();
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(map(row));
    }
    return out;
  }

  /** Distinct lawyers previously entered (latest values win), newest first. */
  async lawyers(): Promise<LawyerSuggestion[]> {
    const rows = await this.prisma.transactions.findMany({
      where: { deleted_at: null, NOT: [{ lawyer_name: null }, { lawyer_name: '' }] },
      orderBy: { id: 'desc' },
      select: { lawyer_name: true, lawyer_email: true, lawyer_phone: true, lawyer_address: true },
    });
    return this.dedupe(
      rows,
      (r) => r.lawyer_name,
      (r) => ({ name: r.lawyer_name, email: r.lawyer_email, phone: r.lawyer_phone, address: r.lawyer_address }),
    );
  }

  /** Distinct brokerages previously entered (contact details only), newest first. */
  async brokerages(): Promise<BrokerageSuggestion[]> {
    const rows = await this.prisma.brokerages.findMany({
      where: { NOT: [{ name: null }, { name: '' }] },
      orderBy: { id: 'desc' },
    });
    return this.dedupe(
      rows,
      (r) => r.name,
      (r) => ({
        name: r.name,
        address: r.address,
        email: r.email,
        invoice_email: r.invoice_email,
        agent_email: r.agent_email,
        phone: r.phone,
      }),
    );
  }
}
