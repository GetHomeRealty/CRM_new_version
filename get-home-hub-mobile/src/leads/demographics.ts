export interface DemographicDraft {
  age?: number | string | null;
  gender?: string | null;
  religion?: string | null;
  date_of_birth?: string | null;
  marriage_day?: string | null;
}

/** Validate only edited fields; absent values must not clear existing data. */
export function serializeDemographics(draft: DemographicDraft): DemographicDraft {
  const result: DemographicDraft = {};
  if ('age' in draft) {
    const raw = String(draft.age ?? '').trim();
    const age = raw === '' ? null : Number(raw);
    if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) throw new Error('Age must be a whole number between 0 and 120.');
    result.age = age;
  }
  if ('religion' in draft) {
    const religion = draft.religion?.trim() || null;
    if (religion && religion.length > 64) throw new Error('Religion must be 64 characters or fewer.');
    result.religion = religion;
  }
  for (const key of ['date_of_birth', 'marriage_day'] as const) {
    if (!(key in draft)) continue;
    const raw = draft[key]?.trim() || null;
    if (raw !== null) {
      const date = new Date(`${raw}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
        throw new Error(`${key === 'date_of_birth' ? 'Birthday' : 'Marriage anniversary'} must be a valid date in YYYY-MM-DD format.`);
      }
    }
    result[key] = raw;
  }
  return result;
}
