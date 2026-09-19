import { MailerService } from './mailer.service';

/**
 * S-1 - production mail leaves this machine and no other.
 *
 * The guard exists because NODE_ENV lives in a file and a file can be copied. Every case below
 * matters: the unset one most of all, because it is what stops the guard becoming an outage.
 */
describe('which machine may send real mail', () => {
  const env = { ...process.env };

  /*
   * S-1 widened the conditions for real delivery from NODE_ENV to four that must agree, so a case
   * about the HOST guard has to satisfy the other three first — otherwise it would pass by
   * diverting for the wrong reason and prove nothing about the host at all.
   */
  const asProduction = (): void => {
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://u:p@db.internal:5432/myapp?schema=public';
    process.env.PRODUCTION_DATABASE_NAME = 'myapp';
    process.env.MAIL_ALLOW_REAL_SEND = '1';
  };
  afterEach(() => { process.env = { ...env }; });

  it('sends for real when no machine is named - todays behaviour, unchanged', () => {
    asProduction();
    delete process.env.MAIL_REAL_SEND_HOST;
    delete process.env.MAIL_REDIRECT_TO;
    expect(MailerService.redirectTarget('any-machine')).toBeNull();
  });

  it('sends for real on the machine that is named', () => {
    asProduction();
    process.env.MAIL_REAL_SEND_HOST = 'srv781514';
    delete process.env.MAIL_REDIRECT_TO;
    expect(MailerService.redirectTarget('srv781514')).toBeNull();
  });

  it('refuses to deliver from any other machine, even calling itself production', () => {
    asProduction();
    process.env.MAIL_REAL_SEND_HOST = 'srv781514';
    delete process.env.MAIL_REDIRECT_TO;
    expect(MailerService.redirectTarget('someones-laptop')).toBe(MailerService.DEV_SINK);
  });

  it('still honours an explicit redirect above everything else', () => {
    asProduction();
    process.env.MAIL_REAL_SEND_HOST = 'srv781514';
    process.env.MAIL_REDIRECT_TO = 'someone@example.test';
    expect(MailerService.redirectTarget('someones-laptop')).toBe('someone@example.test');
  });

  it('leaves a developer machine exactly as it was - diverted', () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_ENV = 'development';
    delete process.env.MAIL_REDIRECT_TO;
    delete process.env.MAIL_ALLOW_REAL_SEND;
    expect(MailerService.redirectTarget('someones-laptop')).toBe(MailerService.DEV_SINK);
  });
});
