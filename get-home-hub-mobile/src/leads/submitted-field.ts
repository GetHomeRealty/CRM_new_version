/** Acknowledges only the exact value saved, preserving subsequent typing. */
export function clearSubmittedField(current: string, submitted: string, empty = ''): string {
  return current === submitted ? empty : current;
}
