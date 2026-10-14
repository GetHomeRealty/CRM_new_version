export function addLeadTag(tags: string[], input: string): string[] {
  const tag = input.trim();
  if (!tag || tags.includes(tag)) return tags;
  if (tags.length >= 50) throw new Error('A lead can have up to 50 tags.');
  return [...tags, tag];
}

export function matchingLeadTags(available: string[], selected: string[], search: string): string[] {
  const query = search.trim().toLocaleLowerCase();
  return available.filter((tag) => !selected.includes(tag) && tag.toLocaleLowerCase().includes(query));
}
