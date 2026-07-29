import { schedulersEnabled, schedulerSkipReason } from './schedulers';

/**
 * The default matters more than the flag. Getting it backwards would silently stop the IMAP
 * poller and the lawyer reminders on the one instance that is supposed to run them, and nothing
 * in the application would report it — mail would simply stop arriving until someone pressed
 * "Sync now".
 */
describe('scheduler ownership', () => {
  const saved = { node: process.env.NODE_ENV, run: process.env.RUN_SCHEDULERS };
  afterEach(() => {
    process.env.NODE_ENV = saved.node;
    if (saved.run === undefined) delete process.env.RUN_SCHEDULERS;
    else process.env.RUN_SCHEDULERS = saved.run;
  });

  const setEnv = (node: string | undefined, run: string | undefined): void => {
    if (node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = node;
    if (run === undefined) delete process.env.RUN_SCHEDULERS; else process.env.RUN_SCHEDULERS = run;
  };

  it('runs by default — the single instance this deployment uses must not need a flag', () => {
    setEnv('production', undefined);
    expect(schedulersEnabled()).toBe(true);
  });

  it('treats an empty value as unset rather than as off', () => {
    setEnv('production', '');
    expect(schedulersEnabled()).toBe(true);
  });

  it.each(['false', '0'])('is off when RUN_SCHEDULERS=%s, for a second instance', (v) => {
    setEnv('production', v);
    expect(schedulersEnabled()).toBe(false);
  });

  it.each(['true', '1'])('is on when RUN_SCHEDULERS=%s', (v) => {
    setEnv('production', v);
    expect(schedulersEnabled()).toBe(true);
  });

  it('never runs under test, whatever the flag says — no network or mail on a timer', () => {
    setEnv('test', 'true');
    expect(schedulersEnabled()).toBe(false);
  });

  it('explains which reason applied, so the boot log is not ambiguous', () => {
    setEnv('test', 'false');
    expect(schedulerSkipReason()).toContain('test');
    setEnv('production', 'false');
    expect(schedulerSkipReason()).toContain('RUN_SCHEDULERS');
  });
});
