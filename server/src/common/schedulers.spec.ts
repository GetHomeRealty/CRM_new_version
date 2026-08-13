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

/**
 * Multi-process safety.
 *
 * The single-instance default above is right for `node dist/main.js` and wrong the moment pm2
 * forks four of them: every process would own every scheduler, and without Redis `clusterTick`
 * runs its tick regardless — so four IMAP pollers would race one mailbox and four workers would
 * sweep the same reminders.
 *
 * The failure modes are not symmetric, which is what decides the default. Forgetting to DISABLE
 * schedulers on the web processes emails a client several times and nobody notices until they
 * complain. Forgetting to ENABLE them on the worker means the sweeps do not run, and
 * `/api/health/workers` reports a stale scheduler within minutes. So under a process manager,
 * silence means no.
 */
describe('scheduler ownership under a process manager', () => {
  const saved = {
    node: process.env.NODE_ENV,
    run: process.env.RUN_SCHEDULERS,
    inst: process.env.NODE_APP_INSTANCE,
    id: process.env.INSTANCE_ID,
  };
  const set = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  afterEach(() => {
    set('NODE_ENV', saved.node); set('RUN_SCHEDULERS', saved.run);
    set('NODE_APP_INSTANCE', saved.inst); set('INSTANCE_ID', saved.id);
  });
  const scenario = (inst: string | undefined, run: string | undefined): void => {
    set('NODE_ENV', 'production'); set('NODE_APP_INSTANCE', inst); set('RUN_SCHEDULERS', run);
    delete process.env.INSTANCE_ID;
  };

  it('a pm2 worker with no explicit flag does NOT run schedulers', () => {
    // The case that would otherwise duplicate every scheduled job N times.
    scenario('0', undefined);
    expect(schedulersEnabled()).toBe(false);
  });

  it('…including instance 0, which is not special', () => {
    // Tempting shortcut: "let instance 0 own them". It cannot — pm2 replaces instance 0 on a crash
    // or a reload, so the role would move without anybody deciding that it should.
    scenario('0', undefined);
    expect(schedulersEnabled()).toBe(false);
    scenario('3', undefined);
    expect(schedulersEnabled()).toBe(false);
  });

  it('the designated worker runs them, because it is told to', () => {
    scenario('0', 'true');
    expect(schedulersEnabled()).toBe(true);
  });

  it('an explicit false is still false, flag beats everything', () => {
    scenario('2', 'false');
    expect(schedulersEnabled()).toBe(false);
  });

  it('a single process with no manager is unaffected — the existing deployment still works', () => {
    scenario(undefined, undefined);
    expect(schedulersEnabled()).toBe(true);
  });

  it('recognises the older INSTANCE_ID name too', () => {
    set('NODE_ENV', 'production'); set('RUN_SCHEDULERS', undefined);
    delete process.env.NODE_APP_INSTANCE; set('INSTANCE_ID', '1');
    expect(schedulersEnabled()).toBe(false);
  });

  it('an empty NODE_APP_INSTANCE is not "under a manager"', () => {
    // Some shells export empty variables. Empty must mean absent, or a plain single process that
    // happens to have the variable set to "" would silently stop running its schedulers.
    scenario('', undefined);
    expect(schedulersEnabled()).toBe(true);
  });

  it('says WHY it stood down, naming the instance', () => {
    // A silent scheduler is the thing that takes an afternoon to diagnose.
    scenario('2', undefined);
    expect(schedulerSkipReason()).toContain('process manager');
    expect(schedulerSkipReason()).toContain('2');
    expect(schedulerSkipReason()).toContain('RUN_SCHEDULERS=true');
  });
});
