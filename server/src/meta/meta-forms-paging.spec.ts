import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MetaController } from './meta.controller';
import { MetaGraphService, GraphError } from './meta-graph.service';

/**
 * EVERY LEAD FORM ON A PAGE — Graph's `/{page}/leadgen_forms` answers in pages, and all of them are
 * read. Meta is mocked (a stubbed `fetch`); the CRM side runs against myapp_test inside a rolled-back
 * transaction. A page that fails, a cursor that repeats, or a Page with more forms than can be listed
 * is an ERROR — never a shortened list presented as the whole.
 */

const prisma = new PrismaClient();
const realFetch = global.fetch;
const ROLLBACK = '__rollback__';
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => { await prisma.$disconnect(); });

const PAGE = 'pg-777';
const form = (n: number) => ({ id: `f${String(n).padStart(4, '0')}`, name: `Form ${n}`, status: n % 7 === 0 ? 'ARCHIVED' : 'ACTIVE', leads_count: n });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => form(from + i));

/** Three pages: 100, 100, 37 — with the default single read, only the first would ever be seen. */
function mockForms(opts: { failOn?: number; repeat?: boolean; overlap?: boolean; pages?: number } = {}) {
  const seen: URL[] = [];
  const total = opts.pages ?? 3;
  global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(url);
    expect(init?.method ?? 'GET').toBe('GET');
    const n = Number(url.searchParams.get('after') ?? '0');
    if (opts.failOn === n) return new Response(JSON.stringify({ error: { message: 'An unexpected error has occurred.', code: 2 } }), { status: 500 });
    const data = n === 2 ? range(201, 237) : n === 1 ? range(opts.overlap ? 95 : 101, 200) : range(1, 100);
    const nextN = opts.repeat && n === 1 ? 1 : n + 1;
    const paging = nextN < total ? { cursors: { after: String(nextN) }, next: `https://graph.facebook.com/v21.0/${PAGE}/leadgen_forms?after=${nextN}&limit=100` } : {};
    return new Response(JSON.stringify({ data, paging }), { status: 200 });
  }) as typeof fetch;
  return seen;
}

describe('MetaGraphService.forms follows every page', () => {
  it('reads all 237 forms across three pages, asking for 100 at a time with the form fields', async () => {
    const seen = mockForms();
    const forms = await new MetaGraphService().forms(PAGE, 'page-token');
    expect(forms).toHaveLength(237);
    expect(forms.map((f) => f.id)).toEqual(range(1, 237).map((f) => f.id));
    expect(seen).toHaveLength(3);
    expect(seen[0].pathname).toBe(`/v21.0/${PAGE}/leadgen_forms`);
    expect(seen[0].searchParams.get('limit')).toBe('100');
    expect(seen[0].searchParams.get('fields')).toBe('id,name,status,leads_count,created_time');
    // archived forms come through like any other — nothing is filtered out
    expect(forms.filter((f) => f.status === 'ARCHIVED')).toHaveLength(33);
  });

  it('a form repeated across overlapping pages is listed once', async () => {
    mockForms({ overlap: true });
    const forms = await new MetaGraphService().forms(PAGE, 't');
    expect(forms).toHaveLength(237);
    expect(new Set(forms.map((f) => f.id)).size).toBe(237);
  });

  it('a failed second page is an error, not 100 forms', async () => {
    mockForms({ failOn: 1 });
    await expect(new MetaGraphService().forms(PAGE, 't')).rejects.toBeInstanceOf(GraphError);
  });

  it('a cursor that repeats is an error, not a partial list', async () => {
    mockForms({ repeat: true, pages: 9 });
    await expect(new MetaGraphService().forms(PAGE, 't')).rejects.toThrow('paging repeated');
  });

  it('a Page with more forms than can be listed is an error, not the first 1000', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const n = Number(new URL(String(input)).searchParams.get('after') ?? '0');
      const data = Array.from({ length: 100 }, (_, i) => form(n * 100 + i + 1));
      return new Response(JSON.stringify({ data, paging: { next: `https://graph.facebook.com/v21.0/${PAGE}/leadgen_forms?after=${n + 1}` } }), { status: 200 });
    }) as typeof fetch;
    await expect(new MetaGraphService().forms(PAGE, 't')).rejects.toThrow('more than 1000 lead forms');
  });
});

describe('GET /api/meta/forms lists every form with its own connected state', () => {
  async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
    try {
      await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
    } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
  }

  it('237 forms from three pages; connected forms on every page keep their setting', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const u = await tx.users.create({ data: { name: 'ZZ Forms Paging', email: `zz-formspaging-${Date.now()}@probe.test`, password: 'x', role: 'admin', status: 'Active', created_at: now, updated_at: now } });
      // connected on page 1, page 2 and page 3 of Graph's answer; one disconnected (is_active false)
      for (const [id, active] of [['f0005', true], ['f0150', true], ['f0230', true], ['f0222', false]] as const) {
        await tx.meta_lead_forms.create({ data: { user_id: u.id, form_id: id, page_id: PAGE, is_active: active, created_at: now, updated_at: now } });
      }
      mockForms();
      const controller = new MetaController(
        { find: async () => ({ pages: [{ page_id: PAGE, name: 'QA Page', token: 'page-token' }] }) } as never,
        new MetaGraphService(), null as never, null as never, tx,
      );
      const res = await controller.forms({ id: u.id, name: u.name, role: 'admin', user_permissions: [] } as unknown as AuthUserRecord, PAGE);
      const forms = res.forms as { id: string; is_connected: boolean; status: string | null }[];
      expect(forms).toHaveLength(237);
      expect(forms.filter((f) => f.is_connected).map((f) => f.id)).toEqual(['f0005', 'f0150', 'f0230']);
      expect(forms.find((f) => f.id === 'f0222')?.is_connected).toBe(false);
      expect(forms.find((f) => f.id === 'f0007')?.status).toBe('ARCHIVED');
    });
  });

  it('a Graph failure reaches the screen as an error with Meta\'s reason — no list at all', async () => {
    mockForms({ failOn: 2 });
    const controller = new MetaController(
      { find: async () => ({ pages: [{ page_id: PAGE, name: 'QA Page', token: 't' }] }) } as never,
      new MetaGraphService(), null as never, null as never, prisma as unknown as PrismaService,
    );
    const err = await controller.forms({ id: 1, name: 'A', role: 'admin', user_permissions: [] } as unknown as AuthUserRecord, PAGE).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().message).toBe('Meta: An unexpected error has occurred.');
  });
});
