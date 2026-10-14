import type { MobileCondition } from './transactions-api';

export function conditionDraftError(conditions: MobileCondition[]): string | null {
  for (const [index, condition] of conditions.entries()) {
    if (!condition.type.trim() || (condition.type === 'Custom' && !condition.custom_name?.trim())) {
      return `Enter a name for condition ${index + 1}.`;
    }
    const deadline = condition.deadline?.trim();
    if (deadline) {
      const date = new Date(`${deadline}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== deadline) {
        return `Enter a valid deadline for condition ${index + 1} (YYYY-MM-DD).`;
      }
    }
  }
  return null;
}

export function conditionChanges(conditions: MobileCondition[]) {
  const error = conditionDraftError(conditions);
  if (error) throw new Error(error);
  return {
    conditional_offer: conditions.length > 0,
    conditions: conditions.map(({ type, custom_name, deadline, status }) => ({
      type,
      custom_name: custom_name?.trim() || null,
      deadline: deadline?.trim() || null,
      status,
    })),
  };
}
