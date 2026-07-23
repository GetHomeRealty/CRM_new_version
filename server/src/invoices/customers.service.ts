import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type customers } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { throwValidation } from '../common/laravel-exceptions';
import { laravelJsonDate } from '../common/serialize';

const FIELDS = ['name', 'address', 'city', 'province', 'postal_code', 'country', 'email', 'phone'] as const;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** All customers ordered by name (raw model JSON, matching Customer::orderBy('name')). */
  async index(): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.customers.findMany();
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return rows.map((c) => this.serialize(c));
  }

  async store(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = this.validate(body);
    const now = new Date();
    const c = await this.prisma.customers.create({ data: { ...data, country: (data.country ?? 'Canada') as string, created_at: now, updated_at: now } as Prisma.customersCreateInput });
    return this.serialize(c);
  }

  async update(id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.prisma.customers.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ message: `No query results for model [App\\Models\\Customer] ${id}.` });
    const data = this.validate(body);
    const c = await this.prisma.customers.update({ where: { id }, data: { ...data, updated_at: new Date() } });
    return this.serialize(c);
  }

  async destroy(id: number): Promise<{ message: string }> {
    const existing = await this.prisma.customers.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ message: `No query results for model [App\\Models\\Customer] ${id}.` });
    await this.prisma.customers.delete({ where: { id } });
    return { message: 'Customer deleted' };
  }

  private validate(body: Record<string, unknown>): Record<string, unknown> {
    if (body.name === undefined || body.name === null || body.name === '') {
      throwValidation({ name: ['The name field is required.'] });
    }
    const data: Record<string, unknown> = {};
    for (const f of FIELDS) if (Object.prototype.hasOwnProperty.call(body, f)) data[f] = body[f];
    return data;
  }

  private serialize(c: customers): Record<string, unknown> {
    return {
      id: c.id,
      name: c.name,
      address: c.address,
      city: c.city,
      province: c.province,
      postal_code: c.postal_code,
      country: c.country,
      email: c.email,
      phone: c.phone,
      created_at: laravelJsonDate(c.created_at),
      updated_at: laravelJsonDate(c.updated_at),
    };
  }
}
