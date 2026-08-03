import { EventSuggestionsService } from './event-suggestions.service';

/**
 * Reading what a model sent back.
 *
 * Everything here is about output nobody controls. A model asked for JSON usually sends JSON and
 * occasionally wraps it in prose or a code fence, invents a field, or returns an empty list — and
 * none of that should reach an agent as a blank panel or a crash. The parser is private, so it is
 * reached the way the service reaches it; the alternative is making it public purely to be tested,
 * which is a worse trade than one bracket access in a spec.
 */

// Both collaborators are stubbed away: `parse` touches neither, and constructing the service is
// only a way to reach a private method that has no business being public.
const parse = (raw: string) =>
  (new EventSuggestionsService({} as never, {} as never) as unknown as { parse(r: string): unknown[] })['parse'](raw);

describe('reading the model\'s reply', () => {
  it('takes a clean JSON object', () => {
    const out = parse(JSON.stringify({
      suggestions: [{ action: 'Call the buyer', why: 'The viewing was yesterday.', urgency: 'high', when: '2026-06-10' }],
    }));
    expect(out).toEqual([{ action: 'Call the buyer', why: 'The viewing was yesterday.', urgency: 'high', when: '2026-06-10' }]);
  });

  it('digs the object out of a code fence or surrounding prose', () => {
    const raw = 'Sure — here you go:\n```json\n{"suggestions":[{"action":"Send the offer","why":"They asked.","urgency":"medium","when":null}]}\n```\nHope that helps!';
    expect(parse(raw)).toHaveLength(1);
  });

  it('falls back to medium when the urgency is not one of the three', () => {
    const out = parse(JSON.stringify({ suggestions: [{ action: 'Do a thing', why: 'x', urgency: 'CRITICAL!!' }] })) as { urgency: string }[];
    expect(out[0].urgency).toBe('medium');
  });

  it('drops a date that is not a date', () => {
    const out = parse(JSON.stringify({ suggestions: [{ action: 'Do a thing', why: 'x', when: 'next Tuesday' }] })) as { when: string | null }[];
    expect(out[0].when).toBeNull();
  });

  it('drops entries with no action, which are not suggestions at all', () => {
    const out = parse(JSON.stringify({ suggestions: [{ action: '', why: 'x' }, { action: 'Real one', why: 'y' }] }));
    expect(out).toHaveLength(1);
  });

  it('caps the list, whatever the model was asked for', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ action: `Action ${i}`, why: 'x', urgency: 'low' }));
    expect(parse(JSON.stringify({ suggestions: many }))).toHaveLength(5);
  });

  it('truncates a rambling action rather than letting it into the UI', () => {
    const out = parse(JSON.stringify({ suggestions: [{ action: 'x'.repeat(500), why: 'y'.repeat(900) }] })) as { action: string; why: string }[];
    expect(out[0].action.length).toBe(200);
    expect(out[0].why.length).toBe(400);
  });
});

describe('when the reply is unusable', () => {
  const unusable = ['', 'I am afraid I cannot help with that.', '{not json at all', 'null', '[]'];

  it.each(unusable)('says so plainly rather than showing an empty panel: %p', (raw) => {
    expect(() => parse(raw)).toThrow();
  });

  it('treats a well-formed but empty list as nothing to show', () => {
    expect(() => parse(JSON.stringify({ suggestions: [] }))).toThrow();
  });

  it('treats a suggestions field that is not a list as nothing to show', () => {
    expect(() => parse(JSON.stringify({ suggestions: 'call them' }))).toThrow();
  });
});
