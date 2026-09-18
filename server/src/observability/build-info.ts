import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-1 - WHICH BUILD IS ANSWERING THIS REQUEST?
 *
 * /api/health said only that the process was alive and how long it had been up, so there was no way
 * to attest which commit was serving traffic - the question that mattered on 2026-09-15, when two
 * people were deploying from one checkout and nobody could tell whose code was live.
 *
 * THE STAMP LIVES INSIDE dist/ ON PURPOSE. deploy.sh restores the previous dist when a boot check,
 * the gate or the health wait fails, so a stamp kept beside the build would go on naming a version
 * that is no longer running - worse than having none. Inside the folder it is restored with it.
 *
 * IT CAN NEVER MAKE THE HEALTH CHECK FAIL. Missing, unreadable or malformed all return "unknown",
 * because deploy.sh waits on this endpoint and treats a non-200 as a failed deploy: a reader that
 * threw here would roll back a perfectly good release.
 */
export interface BuildInfo {
  commit: string;
  built_at: string | null;
}

/** Exported separately from the constant below so the failure cases can be tested. Never throws. */
export function readBuildInfo(file: string): BuildInfo {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const commit = typeof parsed.commit === 'string' ? parsed.commit.trim() : '';
    const builtAt = typeof parsed.built_at === 'string' ? parsed.built_at.trim() : '';
    return { commit: commit ? commit.slice(0, 40) : 'unknown', built_at: builtAt || null };
  } catch {
    return { commit: 'unknown', built_at: null };
  }
}

/** Read once at start-up: the build cannot change under a running process. */
export const BUILD_INFO: BuildInfo = readBuildInfo(join(__dirname, '..', 'build-info.json'));
