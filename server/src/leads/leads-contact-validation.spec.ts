import { LeadsService } from './leads.service';

describe('lead contact validation', () => {
  const service = new LeadsService({} as never, {} as never, {} as never);
  const validate = (input: Record<string, unknown>) =>
    (service as unknown as {
      validate(value: Record<string, unknown>, create: boolean): Promise<Record<string, unknown>>;
    }).validate(input, true);

  it('accepts a phone-only lead and stores a missing email as null', async () => {
    await expect(validate({ name: 'Phone Only', email: '', phone: '416-555-0100' })).resolves.toMatchObject({
      name: 'Phone Only',
      email: null,
      phone: '416-555-0100',
      phone_normalized: '4165550100',
    });
  });

  it('requires a phone number when creating a lead', async () => {
    await expect(validate({ name: 'No Phone', email: '', phone: '' })).rejects.toMatchObject({
      response: expect.objectContaining({
        errors: expect.objectContaining({ phone: ['A phone number is required.'] }),
      }),
      status: 422,
    });
  });
});
