import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { NoticeOfSaleService } from './notice-of-sale.service';
import { QuickSendService } from './quick-send.service';

/**
 * TD-116, REVERSED BY THE BROKERAGE ON 2026-09-23 — the Trade Record Sheet and the Notice of Sale
 * belong to the admin team, not to the agent.
 *
 * WHAT THIS FILE USED TO ASSERT, and why it was right at the time. The two actions were hidden from
 * agents while the Lawyer Details modal told them their eight fields "auto-fill the Notice of Sale
 * and Trade Sheet documents" - the product asked for work and hid the result. Asked to settle it,
 * the brokerage granted the actions, and this spec pinned that.
 *
 * WHAT THE BROKERAGE SAYS NOW, and it answers the same question the other way: Lawyer Details is
 * where an agent records the lawyer for a deal; that data reaches the admin portal and the admin
 * team prepares both documents from it and raises them to the agent for signing. So the agent needs
 * the FIELDS, not the DOCUMENTS - and the footnote is corrected rather than the actions granted.
 * The old spec's last case said this in advance: "had the brokerage chosen the other branch, this
 * is the line that would have had to change instead, and this assertion would have been its
 * opposite." It is.
 *
 * THE HALF THAT NEVER EXISTED BEFORE, and the reason this is not just a hidden button again. The
 * old arrangement was a CURTAIN: the endpoints accepted an agent on their own deal, and only the
 * markup stopped them - the code said so itself. Hiding the buttons again would restore exactly
 * that. The server now refuses the role outright, in the same shape the Lawyer Statement has always
 * used, and the cases below call the services directly to prove it.
 */

const CLIENT = join(__dirname, '..', '..', '..', 'client', 'src', 'desk');
const strip = (f: string): string =>
  readFileSync(join(CLIENT, f), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const page = strip('TransactionDetailPage.tsx');
const lawyer = strip('LawyerModal.tsx');

/** The single JSX line that renders one header button, found by its label. */
const control = (label: string): string => {
  const line = page.split('\n').find((l) => l.includes(`> ${label}`) && l.includes('<button'));
  expect(line).toBeDefined();
  return line!;
};

/* The guard is the first statement in each method and touches nothing on `this`, so a bare
 * prototype is enough to reach it - and proves the refusal cannot depend on any dependency. */
const nos = Object.create(NoticeOfSaleService.prototype) as NoticeOfSaleService;
const quick = Object.create(QuickSendService.prototype) as QuickSendService;
const agent = { id: 9, name: 'QA Agent', role: 'agent' } as never;
const staff = { id: 1, name: 'QA Admin', role: 'admin' } as never;
const raised = (p: Promise<unknown>): Promise<unknown> => p.then((v) => v, (e) => e);

describe('the closing paperwork belongs to the admin team (TD-116, reversed 2026-09-23)', () => {
  for (const label of ['Trade Sheet', 'Notice of Sale']) {
    describe(label, () => {
      it('is hidden from the agent role outright, own deal or not', () => {
        expect(control(label)).toMatch(/\{!isAgent &&/);
      });

      it('is not offered back to a full agent by the side door', () => {
        expect(control(label)).not.toContain('isFullAgent');
      });

      it('still respects the status rules, which are not about role', () => {
        // docsOnly is a Void / Mutual Release deal; hideTradeSheet and hideStmtNos are statuses too
        // early for the document to mean anything. They hide these from an administrator too.
        expect(control(label)).toContain('!docsOnly');
        expect(control(label)).toContain(label === 'Trade Sheet' ? '!hideTradeSheet' : '!hideStmtNos');
      });
    });
  }

  it('no longer promises the agent documents they cannot produce', () => {
    expect(lawyer).not.toContain('Used to auto-fill the Notice of Sale and Trade Sheet documents');
    expect(lawyer).toContain('Used by the brokerage to prepare the Notice of Sale and Trade Record Sheet');
  });

  it('REFUSES AN AGENT ON THE SERVER, on every Notice of Sale route', async () => {
    expect(await raised(nos.show(agent, 1))).toBeInstanceOf(ForbiddenException);
    expect(await raised(nos.save(agent, 1, {}))).toBeInstanceOf(ForbiddenException);
    expect(await raised(nos.send(agent, 1, {}))).toBeInstanceOf(ForbiddenException);
  });

  it('REFUSES AN AGENT ON THE SERVER, on both Trade Record Sheet routes', async () => {
    expect(await raised(quick.tradeSheet(agent, 1, {}))).toBeInstanceOf(ForbiddenException);
    expect(await raised(quick.tradeSheetGenerated(agent, 1))).toBeInstanceOf(ForbiddenException);
  });

  it('refuses them for being an agent and for nothing else', async () => {
    // Brokerage staff get past the role check and fail later on an unwired dependency, which is the
    // point: a Forbidden here would mean the rule had caught the wrong people.
    expect(await raised(quick.tradeSheet(staff, 1, {}))).not.toBeInstanceOf(ForbiddenException);
    expect(await raised(nos.show(staff, 1))).not.toBeInstanceOf(ForbiddenException);
  });
});
