import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PermissionService } from '../auth/permission.service';
import type { AuthUserRecord } from '../auth/auth.types';
import {
  MARKETING_ITEM_TYPES,
  assignedToLabel,
  deriveStatusFor,
  displayType,
  normalizeAssignments,
  sanitizeAssignments,
  type InventoryAssignment,
  type MarketingInventoryItem,
} from './marketing-inventory.model';

type Row = Prisma.marketing_inventoryGetPayload<Record<string, never>>;

interface ListQuery {
  deleted?: boolean;
  search?: string;
  type?: string;
  status?: string;
}

@Injectable()
export class MarketingInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  /** "Admins" (full manage + see all) are anyone with edit on the inventory screen. */
  private canManage(user: AuthUserRecord): boolean {
    return this.permissions.can(user.role || 'agent', user.user_permissions, 'inventory', 'edit');
  }

  /** DB row → the camelCase logical item the model + client expect. */
  private toItem(row: Row): MarketingInventoryItem {
    const assignments = Array.isArray(row.assignments) ? (row.assignments as unknown as InventoryAssignment[]) : [];
    return {
      _id: String(row.id),
      asOnDate: row.as_on_date ?? '',
      type: row.type,
      customType: row.custom_type ?? '',
      count: row.count ?? 0,
      assignments,
      assignedQty: row.assigned_qty ?? 0,
      assignedTo: row.assigned_to ?? '',
      assignedDate: row.assigned_date ?? '',
      returnedDate: row.returned_date ?? '',
      status: row.status,
      remarks: row.remarks ?? '',
      createdAt: row.created_at?.toISOString(),
      updatedAt: row.updated_at?.toISOString(),
      deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    };
  }

  /**
   * Strip a shared row down to one holder's own stake — other holders' names and quantities
   * must never reach an agent's browser. `count` becomes the holder's own quantity so every
   * derived figure reads as "yours". Mirrors reduceItemToHolder in the source.
   */
  private reduceToHolder(item: MarketingInventoryItem, holderName: string): MarketingInventoryItem {
    const name = holderName.trim().toLowerCase();
    const mine = normalizeAssignments(item).filter((a) => (a.assignedTo || '').trim().toLowerCase() === name);
    const qty = mine.reduce((sum, a) => sum + (Number(a.qty) || 0), 0);
    const reduced: MarketingInventoryItem = {
      ...item,
      assignments: mine,
      assignedQty: qty,
      count: qty,
      assignedTo: mine[0]?.assignedTo || '',
      assignedDate: mine[0]?.assignedDate || '',
      returnedDate: mine[0]?.returnedDate || '',
    };
    return { ...reduced, status: deriveStatusFor(reduced) };
  }

  /** Whether a non-admin actor holds any units of this row (mirrors canViewInventoryItem). */
  private holdsAny(item: MarketingInventoryItem, name: string): boolean {
    const n = name.trim().toLowerCase();
    if (!n) return false;
    return normalizeAssignments(item).some((a) => (a.assignedTo || '').trim().toLowerCase() === n);
  }

  private validType(type: unknown): type is string {
    return typeof type === 'string' && (MARKETING_ITEM_TYPES as readonly string[]).includes(type);
  }

  // ------------------------------------------------------------------ read
  async list(user: AuthUserRecord, q: ListQuery): Promise<{ items: MarketingInventoryItem[]; total: number }> {
    const manage = this.canManage(user);
    // The recycle bin is an admin-only concept — agents never see deleted stock.
    const wantDeleted = !!q.deleted && manage;

    const rows = await this.prisma.marketing_inventory.findMany({
      where: wantDeleted ? { deleted_at: { not: null } } : { deleted_at: null },
      orderBy: { created_at: 'desc' },
    });

    let items = rows.map((r) => this.toItem(r));

    // Scope non-admins to their own stock, then reduce each row to their stake.
    if (!manage) {
      const name = (user.name || '').trim();
      items = items.filter((i) => this.holdsAny(i, name)).map((i) => this.reduceToHolder(i, name));
    }

    // Optional filters (small dataset — done in memory so JSON holders are searchable).
    const type = (q.type || '').trim();
    const status = (q.status || '').trim();
    const search = (q.search || '').trim().toLowerCase();
    if (type) items = items.filter((i) => i.type === type);
    if (status) items = items.filter((i) => i.status === status);
    if (search) {
      items = items.filter((i) =>
        [displayType(i), i.remarks, i.status, ...normalizeAssignments(i).map((a) => a.assignedTo)]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(search)),
      );
    }

    return { items, total: items.length };
  }

  async getOne(user: AuthUserRecord, id: number): Promise<MarketingInventoryItem> {
    const row = await this.prisma.marketing_inventory.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ error: 'Item not found' });
    const item = this.toItem(row);
    if (this.canManage(user)) return item;
    // 404 (not 403) — an agent should not learn a row they cannot see exists.
    if (!this.holdsAny(item, user.name || '')) throw new NotFoundException({ error: 'Item not found' });
    return this.reduceToHolder(item, user.name || '');
  }

  // ---------------------------------------------------------------- mutate
  /** Build the persisted column set from a validated count + assignments list. */
  private columnsFrom(
    count: number,
    assignments: InventoryAssignment[],
  ): Pick<Prisma.marketing_inventoryUncheckedCreateInput, 'count' | 'assignments' | 'assigned_qty' | 'assigned_to' | 'assigned_date' | 'returned_date' | 'status'> {
    const assignedQty = assignments.reduce((s, a) => s + a.qty, 0);
    return {
      count,
      assignments: assignments as unknown as Prisma.InputJsonValue,
      assigned_qty: assignedQty,
      assigned_to: assignedToLabel({ assignments } as MarketingInventoryItem),
      assigned_date: assignments[0]?.assignedDate || '',
      returned_date: assignments[0]?.returnedDate || '',
      status: deriveStatusFor({ count, assignments, assignedQty } as MarketingInventoryItem),
    };
  }

  async create(user: AuthUserRecord, body: Record<string, unknown>, allowMerge = true): Promise<Record<string, unknown>> {
    if (!this.validType(body.type)) throw new BadRequestException({ error: 'A valid Type is required' });
    const type = body.type;
    const count = Number(body.count);
    if (!Number.isFinite(count) || count < 0) throw new BadRequestException({ error: 'Count must be 0 or more' });

    const assignments = Array.isArray(body.assignments)
      ? sanitizeAssignments(body.assignments)
      : sanitizeAssignments([{ assignedTo: body.assignedTo, qty: body.assignedQty, assignedDate: body.assignedDate, returnedDate: body.returnedDate }]);

    const assignedQty = assignments.reduce((s, a) => s + a.qty, 0);
    if (assignedQty > count) throw new BadRequestException({ error: 'Total assigned across all people cannot exceed the count' });

    const now = new Date();
    const customType = type === 'Custom' ? String(body.customType || '').trim() : '';
    const remarks = String(body.remarks || '').trim();
    const asOnDate = String(body.asOnDate || '').slice(0, 10) || this.today();

    // One row per item type: adding a type that already exists folds into that row.
    const existing = allowMerge
      ? await this.prisma.marketing_inventory.findFirst({
          where: {
            deleted_at: null,
            type,
            ...(type === 'Custom' ? { custom_type: { equals: customType, mode: 'insensitive' } } : {}),
          },
        })
      : null;

    if (existing) {
      const merged = [...normalizeAssignments(this.toItem(existing)), ...assignments];
      const mergedCount = (Number(existing.count) || 0) + count;
      const cols = this.columnsFrom(mergedCount, merged);
      const mergedRemarks = [existing.remarks, remarks]
        .map((r) => (r || '').trim())
        .filter(Boolean)
        .filter((r, i, arr) => arr.indexOf(r) === i)
        .join(' | ');

      const row = await this.prisma.marketing_inventory.update({
        where: { id: existing.id },
        data: {
          ...cols,
          remarks: mergedRemarks,
          as_on_date: asOnDate > (existing.as_on_date || '') ? asOnDate : existing.as_on_date,
          updated_at: now,
        },
      });
      await this.log(user, 'merged', `Merged +${count} into existing ${displayType(this.toItem(existing))} (now ${mergedCount})`);
      return { id: String(row.id), merged: true, addedCount: count, item: this.toItem(row) };
    }

    const row = await this.prisma.marketing_inventory.create({
      data: {
        as_on_date: asOnDate,
        type,
        custom_type: customType,
        remarks,
        ...this.columnsFrom(count, assignments),
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
    });
    await this.log(user, 'created', `Marketing inventory added: ${displayType(this.toItem(row))} (qty ${count})`);
    return { id: String(row.id), merged: false, item: this.toItem(row) };
  }

  async update(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.prisma.marketing_inventory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'Item not found' });

    // Merge against the stored row so a partial update can't silently zero a field.
    const type = body.type ?? existing.type;
    if (!this.validType(type)) throw new BadRequestException({ error: 'A valid Type is required' });
    const count = body.count !== undefined ? Number(body.count) : Number(existing.count);
    if (!Number.isFinite(count) || count < 0) throw new BadRequestException({ error: 'Count must be 0 or more' });

    const assignments = Array.isArray(body.assignments)
      ? sanitizeAssignments(body.assignments)
      : normalizeAssignments(this.toItem(existing));

    const assignedQty = assignments.reduce((s, a) => s + a.qty, 0);
    if (assignedQty > count) throw new BadRequestException({ error: 'Total assigned across all people cannot exceed the count' });

    const row = await this.prisma.marketing_inventory.update({
      where: { id },
      data: {
        as_on_date: (body.asOnDate as string | undefined) ?? existing.as_on_date,
        type,
        custom_type: type === 'Custom' ? String((body.customType ?? existing.custom_type) || '').trim() : '',
        remarks: String((body.remarks ?? existing.remarks) || '').trim(),
        ...this.columnsFrom(count, assignments),
        updated_at: new Date(),
      },
    });
    await this.log(user, 'updated', `Marketing inventory updated: ${displayType(this.toItem(row))}`);
    return { success: true, item: this.toItem(row) };
  }

  async remove(user: AuthUserRecord, id: number, permanent: boolean): Promise<{ success: boolean; permanent: boolean }> {
    const existing = await this.prisma.marketing_inventory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'Item not found' });

    if (permanent) {
      await this.prisma.marketing_inventory.delete({ where: { id } });
    } else {
      await this.prisma.marketing_inventory.update({ where: { id }, data: { deleted_at: new Date(), updated_at: new Date() } });
    }
    await this.log(user, permanent ? 'purged' : 'deleted', `Marketing inventory ${permanent ? 'permanently deleted' : 'moved to deleted'}: ${displayType(this.toItem(existing))}`);
    return { success: true, permanent };
  }

  async restore(user: AuthUserRecord, id: number): Promise<{ success: boolean; alreadyActive?: boolean }> {
    const existing = await this.prisma.marketing_inventory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'Item not found' });
    if (!existing.deleted_at) return { success: true, alreadyActive: true };
    await this.prisma.marketing_inventory.update({ where: { id }, data: { deleted_at: null, updated_at: new Date() } });
    await this.log(user, 'restored', `Marketing inventory restored: ${displayType(this.toItem(existing))}`);
    return { success: true };
  }

  /** Distinct user names for the "Assigned To" dropdown. Kept here so it doesn't depend on the
   *  admin-only Users screen — a manager can open the inventory form without Users access. */
  async assignableNames(): Promise<string[]> {
    const rows = await this.prisma.users.findMany({ select: { name: true }, orderBy: { name: 'asc' } });
    const names = rows.map((r) => (r.name || '').trim()).filter(Boolean);
    return Array.from(new Set(names));
  }

  private today(): string {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }

  private async log(user: AuthUserRecord, action: string, details: string): Promise<void> {
    await this.audit.logModule({ id: user.id, name: user.name }, 'Marketing Inventory', {
      action,
      details,
      section: 'Marketing Inventory',
    });
  }
}
