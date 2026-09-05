import { expect, test } from '@playwright/test';
import { signIn, signOut, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * TD-078 — the agent's read-only document status says what the record holds.
 *
 * THE DEFECT. The read-only branch of the Legal & Documentation list rendered
 * `status === 'Received' ? 'Sent' : 'Pending'`, so a document stored as **Received** was printed to
 * the agent as **Sent**. That is not a shorter word for the same thing: "Received" says the
 * brokerage HAS the document; "Sent" says it went out. On a compliance checklist that is the
 * difference between an obligation discharged and one still outstanding — and the person shown the
 * wrong word is the agent who uploaded the file, while the counter directly above the same table
 * ("1 / 10 received") and the administrator's dropdown on the same row both said Received.
 *
 * WHY A BROWSER TEST. The bug was role-specific RENDERING: the same row, read by two roles, drawn
 * two different ways. Only a browser can assert the words each role actually sees, and only with
 * both roles in one test is "they now agree" a thing that can be checked at all.
 *
 * The deal is created for the run and deleted afterwards.
 */

test('an agent and an administrator read the same word on the same document row (TD-078)', async ({ page }) => {
  await signIn(page, 'superAdmin');
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: 'ZZ-TEST TD-078 Document Road',
    status: 'Secured Firm',
    price: 500000,
    comm_type: '%',
    comm_value: 2.5,
    offer_date: '2026-08-13',
    closing_date: '2026-09-30',
    primary_agent: ACCOUNTS.agent.name,
  });
  expect(created.status).toBe(201);
  const id = (created.body as { data: { id: number } }).data.id;

  try {
    // The ten rows a Buying deal seeds, with one marked Received — the state the defect misprints.
    const docs = await apiGet(page, `/api/transactions/${id}/documents`);
    const rows = ((docs.body as { documents?: { id: number; title: string; status: string }[] })?.documents) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const target = rows[0];

    const saved = await apiSend(page, 'PUT', `/api/transactions/${id}/documents`, {
      documents: rows.map((d) => (d.id === target.id ? { ...d, status: 'Received' } : d)),
    });
    expect(saved.status).toBe(200);

    const stored = ((await apiGet(page, `/api/transactions/${id}/documents`)).body as { documents?: { id: number; status: string }[] })
      ?.documents?.find((d) => d.id === target.id);
    expect(stored?.status).toBe('Received');

    /** The status cell of a row, as the signed-in role sees it. */
    const statusCellText = async (title: string = target.title): Promise<string> => {
      await page.goto(`/desk/transactions/${id}?mode=view`);
      await page.getByRole('button', { name: /legal & docs/i }).first().click();
      const row = page.locator('.doc-row').filter({ hasText: title }).first();
      await expect(row).toBeVisible();
      // A dropdown for an administrator, static text for an agent — both carry `doc-status`, so
      // the same cell is read either way rather than scraping the whole row (whose text includes
      // every option of every dropdown on it, which would make any assertion vacuous).
      const cell = row.locator('.doc-status').first();
      await expect(cell).toBeVisible();
      const tag = await cell.evaluate((el) => el.tagName);
      return tag === 'SELECT' ? await cell.inputValue() : (await cell.innerText()).trim();
    };

    const adminSees = await statusCellText();
    await signOut(page);
    await signIn(page, 'agent');
    const agentSees = await statusCellText();

    console.log(`  admin sees: ${adminSees}`);
    console.log(`  agent sees: ${agentSees}`);

    expect(adminSees).toBe('Received');
    expect(agentSees).toBe('Received');
    // The word that is not in the document model at all.
    expect(agentSees).not.toContain('Sent');

    // A row still awaiting its document reads Pending to the agent, as it always did — the fix is
    // that ONE state was mislabelled, not that the cell now prints something new.
    const untouched = rows.find((d) => d.id !== target.id && d.status !== 'Received');
    if (untouched) expect(await statusCellText(untouched.title)).toBe('Pending');
  } finally {
    await signOut(page);
    await signIn(page, 'superAdmin');
    await apiSend(page, 'DELETE', `/api/transactions/${id}`);
  }
});
