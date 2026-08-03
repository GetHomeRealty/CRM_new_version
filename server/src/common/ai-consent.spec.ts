import { ServiceUnavailableException } from '@nestjs/common';
import { AI_FEATURES, aiFeatureEnabled, aiFeatureStates, assertAiFeatureEnabled, type AiFeatureKey } from './ai-consent';

/**
 * The default is the whole point.
 *
 * Every one of these features used to enable itself as soon as any provider API key was present in
 * the environment — and the provider layer accepts whichever of ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GEMINI_API_KEY it finds, so a key set for one purpose silently switched on the others. Nobody
 * chose to send client information anywhere. These tests exist so that "off unless deliberately
 * switched on" cannot regress quietly, and so a feature added later has to declare what it
 * discloses before it can ship.
 */
describe('AI feature consent', () => {
  const KEYS = Object.keys(AI_FEATURES) as AiFeatureKey[];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      const env = AI_FEATURES[k].env;
      saved[env] = process.env[env];
      delete process.env[env];
    }
  });
  afterEach(() => {
    for (const [env, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[env];
      else process.env[env] = value;
    }
  });

  it('is off when nothing is set, for every feature', () => {
    for (const k of KEYS) {
      expect({ k, on: aiFeatureEnabled(k) }).toEqual({ k, on: false });
      expect(() => assertAiFeatureEnabled(k)).toThrow(ServiceUnavailableException);
    }
  });

  it('is off for anything other than the literal "on"', () => {
    // A half-set variable must not count as consent. `true`, `1` and `yes` all read as intent to
    // somebody and none of them is the documented value.
    for (const value of ['', 'off', 'false', '0', 'true', '1', 'yes', 'enabled', ' ']) {
      process.env[AI_FEATURES['lead-email-drafting'].env] = value;
      expect({ value, on: aiFeatureEnabled('lead-email-drafting') }).toEqual({ value, on: false });
    }
  });

  it('is on for "on", whatever the casing or padding', () => {
    for (const value of ['on', 'ON', ' On ']) {
      process.env[AI_FEATURES['lead-email-drafting'].env] = value;
      expect({ value, on: aiFeatureEnabled('lead-email-drafting') }).toEqual({ value, on: true });
      expect(() => assertAiFeatureEnabled('lead-email-drafting')).not.toThrow();
    }
  });

  it('enabling one feature never enables another', () => {
    // The exact failure this catalogue was built to remove.
    process.env[AI_FEATURES['lead-email-drafting'].env] = 'on';
    expect(aiFeatureEnabled('lead-email-drafting')).toBe(true);
    expect(aiFeatureEnabled('calendar-followup-suggestions')).toBe(false);
    expect(aiFeatureEnabled('fintrac-id-extraction')).toBe(false);
  });

  it('tells the administrator what the switch would consent to, not just its name', () => {
    try {
      assertAiFeatureEnabled('fintrac-id-extraction');
      throw new Error('expected a refusal');
    } catch (e) {
      // `getResponse()` is the object the client receives, not a string — stringifying it whole
      // gives "[object Object]" and an assertion that can never fail for the right reason.
      const body = (e as ServiceUnavailableException).getResponse() as { message?: string };
      const message = body.message ?? '';
      // The variable to set, AND what setting it means. A refusal naming only the variable invites
      // somebody to set it without knowing that identity documents are what gets sent.
      expect(message).toContain('AI_ID_EXTRACTION');
      expect(message).toMatch(/identity document/i);
      expect(message).toMatch(/privacy policy/i);
    }
  });

  it('makes every feature declare what it discloses', () => {
    for (const k of KEYS) {
      const f = AI_FEATURES[k];
      expect(f.env).toMatch(/^AI_[A-Z_]+$/);
      expect(['low', 'medium', 'high']).toContain(f.sensitivity);
      // Long enough to be a description rather than a label. The catalogue is the privacy review's
      // source of truth, so a one-word entry would defeat it.
      expect(f.discloses.length).toBeGreaterThan(60);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it('reports the state of every feature for the privacy review', () => {
    process.env[AI_FEATURES['lead-email-drafting'].env] = 'on';
    const states = aiFeatureStates();
    expect(states).toHaveLength(KEYS.length);
    expect(states.find((s) => s.key === 'lead-email-drafting')?.enabled).toBe(true);
    expect(states.find((s) => s.key === 'fintrac-id-extraction')).toMatchObject({ enabled: false, sensitivity: 'high' });
  });
});
