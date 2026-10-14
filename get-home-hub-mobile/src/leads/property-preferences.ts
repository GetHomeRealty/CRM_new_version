export interface PropertyPreference {
  [key: string]: unknown;
  budget?: { [key: string]: unknown; min?: number | string | null; max?: number | string | null };
  propertyType?: string[];
  bedrooms?: number | string | null;
  bathrooms?: number | string | null;
  squareFootage?: number | string | null;
  yearBuilt?: number | string | null;
  lotSize?: string;
  parking?: number | string | null;
  locations?: string[];
  features?: string[];
}

export const preferenceNumbers = [
  ['bedrooms', 'Bedrooms'], ['bathrooms', 'Bathrooms'], ['squareFootage', 'Square footage'],
  ['yearBuilt', 'Year built'], ['parking', 'Parking'],
] as const;

function numberValue(value: unknown, label: string): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`);
  return number;
}

/** Keep unknown imported fields while converting only fields edited as numeric text. */
export function serializePreferences(preferences: PropertyPreference[]): PropertyPreference[] {
  return preferences.map((preference, index) => {
    const result = { ...preference };
    for (const key of ['propertyType', 'locations', 'features'] as const) {
      if (preference[key]) result[key] = [...new Set(preference[key].map((text) => text.trim()).filter(Boolean))];
    }
    for (const [key, label] of preferenceNumbers) {
      if (key in preference) result[key] = numberValue(preference[key], `Preference ${index + 1}: ${label}`);
    }
    if (preference.budget) {
      result.budget = { ...preference.budget };
      for (const key of ['min', 'max'] as const) {
        if (key in preference.budget) result.budget[key] = numberValue(preference.budget[key], `Preference ${index + 1}: Budget ${key}`);
      }
    }
    return result;
  });
}
