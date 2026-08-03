import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Which AI features are switched on, and what each one sends out of the building.
 *
 * WHY A CATALOGUE RATHER THAN AN `if` PER FEATURE. Three separate places in this application send
 * client information to a third-party model, and until this file existed each decided for itself
 * whether it was allowed to — which in practice meant none of them did. All three turned themselves
 * on the moment an API key appeared in the environment, including a key set for an unrelated
 * feature, because `resolveEmailAi()` reads whichever of ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GEMINI_API_KEY is present. Configuring one feature silently enabled the others.
 *
 * That is the wrong default for this data. Under PIPEDA the brokerage is accountable for personal
 * information it discloses to a processor, whether or not anyone noticed the disclosure was
 * happening; "an API key was in the .env" is not a record of a decision. Each feature now needs its
 * own switch, set deliberately, and `discloses` says in plain words what that switch consents to —
 * so the person setting it can answer the only question that matters: *is the brokerage willing to
 * send THAT to a company outside it?*
 *
 * A key still gates whether the feature CAN run. This gates whether it MAY.
 */

export interface AiFeature {
  /** Environment variable that turns it on. Set to `on` — anything else, including unset, is off. */
  readonly env: string;
  /** What the person setting the switch is agreeing to send. Written for a reader, not a developer. */
  readonly discloses: string;
  /** How sensitive the disclosure is, for the privacy review and for ordering decisions. */
  readonly sensitivity: 'low' | 'medium' | 'high';
  /** Shown to the user when the feature is off, so the refusal explains itself. */
  readonly label: string;
}

export const AI_FEATURES = {
  /**
   * "Draft with AI" on a lead. See LeadActivityService.generateEmail.
   */
  'lead-email-drafting': {
    env: 'AI_EMAIL_DRAFTING',
    label: 'AI email drafting',
    sensitivity: 'low',
    discloses:
      "the lead's FIRST NAME, the agent's name and email, and the instruction the agent typed. "
      + 'Deliberately not the rest of the lead record — no email address, phone, budget or property details.',
  },

  /**
   * "Suggest follow-ups" on a calendar appointment. See EventSuggestionsService.forEvent.
   */
  'calendar-followup-suggestions': {
    env: 'AI_CALENDAR_SUGGESTIONS',
    label: 'AI follow-up suggestions',
    sensitivity: 'medium',
    discloses:
      'the appointment record in full — its title, kind, date, status, location, ATTENDEES and any '
      + 'notes or property details the agent typed — plus the linked lead\'s name and status, and the '
      + "linked deal's trade number and property address. Free text an agent wrote about a client "
      + 'goes with it.',
  },

  /**
   * FINTRAC Form 630 identity extraction. See IdExtractionService.extractIdFields.
   *
   * The most sensitive disclosure this application makes, by a distance, and the one that was
   * gated last.
   */
  'fintrac-id-extraction': {
    env: 'AI_ID_EXTRACTION',
    label: 'AI identity-document extraction',
    sensitivity: 'high',
    discloses:
      'the COMPLETE IMAGE OR PDF of a government identity document — a passport, driver\'s licence '
      + 'or provincial ID — uploaded to the model as base64. Not extracted text: the document itself, '
      + 'including the photograph, the document number, the date of birth and the home address printed '
      + 'on it.',
  },
} as const satisfies Record<string, AiFeature>;

export type AiFeatureKey = keyof typeof AI_FEATURES;

/** Whether this feature has been deliberately switched on. Unset means off. */
export function aiFeatureEnabled(key: AiFeatureKey): boolean {
  return (process.env[AI_FEATURES[key].env] ?? '').trim().toLowerCase() === 'on';
}

/**
 * Refuse unless the feature has been switched on, saying what the switch would consent to.
 *
 * A 503 rather than a 403: the caller is entitled to use the feature, it is the deployment that has
 * not enabled it, and the message has to tell an administrator what enabling it means rather than
 * just naming a variable to set.
 */
export function assertAiFeatureEnabled(key: AiFeatureKey): void {
  if (aiFeatureEnabled(key)) return;
  const f = AI_FEATURES[key];
  throw new ServiceUnavailableException({
    message:
      `${f.label} is switched off. When enabled it sends ${f.discloses} to an external AI provider, `
      + `so it has to be turned on deliberately: set ${f.env}=on once the brokerage has confirmed `
      + 'that is acceptable under its privacy policy.',
  });
}

/** Every feature and its current state — for the privacy review and the health endpoint. */
export function aiFeatureStates(): { key: string; env: string; enabled: boolean; sensitivity: string }[] {
  return (Object.keys(AI_FEATURES) as AiFeatureKey[]).map((key) => ({
    key,
    env: AI_FEATURES[key].env,
    enabled: aiFeatureEnabled(key),
    sensitivity: AI_FEATURES[key].sensitivity,
  }));
}
