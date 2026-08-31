import { CrmAdvancedEmailService } from '../crm-settings/crm-advanced-email.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-024: an import must be able to say, first, that it will email everybody in the file.
 *
 * WHAT THE IMPORT ACTUALLY DOES. It creates records AND makes every new lead eligible for the
 * welcome sweep, so a five-hundred-row spreadsheet is five hundred members of the public emailed by
 * the brokerage. The window described the file format and nothing else; the job report gave nine
 * figures and never mentioned email; and the sweep runs on a delay, so the operator who saw
 * "500 imported" and closed the window was usually gone before the first message left.
 *
 * WHY THE ANSWER CANNOT BE ASSUMED BY THE SCREEN. Four independent things decide whether a welcome
 * really leaves: the sender's own trigger, the brokerage kill switch, the template being active,
 * and a connected mailbox. A warning built on any subset would either cry wolf - which is worse
 * than silence, because people stop reading it - or promise quiet it cannot deliver.
 *
 * SO THE TEST IS THAT THE PREFLIGHT AGREES WITH THE SEND. Each case switches one of those four off
 * and asserts the preflight notices, which is what stops the warning drifting away from the
 * behaviour it describes.
 */

const USER = { id: 7, name: 'Importer', role: 'agent' } as unknown as AuthUserRecord;

function build(opts: {
  triggerOn?: boolean; autoSend?: boolean; templateActive?: boolean; hasMailbox?: boolean;
} = {}) {
  const {
    triggerOn = true, autoSend = true, templateActive = true, hasMailbox = true,
  } = opts;

  const prisma = {
    crm_email_settings: { findFirst: async () => ({ id: 1, auto_send_enabled: autoSend, template_toggles: null }) },
    email_templates: { findUnique: async () => ({ name: 'CRM Welcome', is_active: templateActive }) },
  } as unknown as PrismaService;

  const triggers = {
    isEnabledFor: async () => triggerOn,
    brokerageDefaultFor: async () => triggerOn,
  } as never;
  const accounts = { senderFor: async () => (hasMailbox ? { id: 1 } : null) } as never;

  return new CrmAdvancedEmailService(prisma, null as never, accounts, triggers);
}

describe('the import preflight answers the question the window has to ask', () => {
  it('says it will email when everything is in place', async () => {
    expect(await build().importWillEmail(USER)).toEqual({ willEmail: true, reason: null });
  });

  it('says it will not when the welcome trigger is off', async () => {
    const r = await build({ triggerOn: false }).importWillEmail(USER);
    expect(r.willEmail).toBe(false);
    expect(r.reason).toMatch(/switched off/i);
  });

  it('says it will not when the brokerage kill switch is off', async () => {
    // The switch that stops ALL per-lead email. A warning that ignored it would be a false alarm on
    // every import a brokerage runs with automation disabled.
    const r = await build({ autoSend: false }).importWillEmail(USER);
    expect(r.willEmail).toBe(false);
    expect(r.reason).toMatch(/switched off for the brokerage/i);
  });

  it('says it will not when the welcome template is inactive', async () => {
    const r = await build({ templateActive: false }).importWillEmail(USER);
    expect(r.willEmail).toBe(false);
    expect(r.reason).toMatch(/template/i);
  });

  it('says it will not when no mailbox is connected', async () => {
    // Nothing can leave, so warning that it will would be the wolf-crying case exactly.
    const r = await build({ hasMailbox: false }).importWillEmail(USER);
    expect(r.willEmail).toBe(false);
    expect(r.reason).toMatch(/email account/i);
  });

  it('gives a reason whenever it says no, so the window can explain itself', async () => {
    for (const opts of [{ triggerOn: false }, { autoSend: false }, { templateActive: false }, { hasMailbox: false }]) {
      const r = await build(opts).importWillEmail(USER);
      expect(r.reason).toBeTruthy();
    }
  });
});
