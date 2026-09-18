import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildInfo } from './build-info';
import { HealthController } from './health.controller';

/** F-1 - the stamp must answer, or say "unknown", but never throw. */
describe('build stamp', () => {
  const tmpFile = (contents: string): string => {
    const f = join(mkdtempSync(join(tmpdir(), 'ghr-build-')), 'build-info.json');
    writeFileSync(f, contents);
    return f;
  };

  it('says unknown when the deploy never wrote one', () => {
    expect(readBuildInfo(join(tmpdir(), 'zz-no-such-build-info.json')))
      .toEqual({ commit: 'unknown', built_at: null });
  });

  it('reads the stamp the deploy wrote', () => {
    const f = tmpFile(JSON.stringify({ commit: 'abc1234', built_at: '2026-09-18T09:00:00Z' }));
    expect(readBuildInfo(f)).toEqual({ commit: 'abc1234', built_at: '2026-09-18T09:00:00Z' });
  });

  it('says unknown rather than throwing on a corrupt file', () => {
    expect(readBuildInfo(tmpFile('not json at all')).commit).toBe('unknown');
  });

  it('says unknown rather than throwing when the commit is missing', () => {
    expect(readBuildInfo(tmpFile('{"built_at":"2026-09-18T09:00:00Z"}')).commit).toBe('unknown');
  });

  it('the liveness answer carries the build', () => {
    const c = new (HealthController as unknown as new () => HealthController)();
    const body = c.live();
    expect(body.status).toBe('ok');
    expect(typeof body.build).toBe('string');
    expect(body.build.length).toBeGreaterThan(0);
  });
});
