/**
 * ================================================================================================
 * THE ONE PASSWORD RULE, SHARED BY EVERY ROUTE THAT SETS A PASSWORD.
 *
 * There were three rules before this, all saying eight characters, in three files that had to be
 * changed together and twice were not: `users.service.ts` for an administrator creating or editing
 * a colleague, `ChangePasswordDto` for somebody changing their own, and — added later as TD-177,
 * after an outside review found it missing — `password-reset.service.ts` for a forgotten password.
 * Registration made a fourth. Four copies of one sentence is how a policy comes to be enforced in
 * three places out of four, which is the same as not being enforced.
 *
 * WHAT THIS REPLACED, AND WHY EIGHT WAS NOT ENOUGH. A production audit found `Admin@123` accepted
 * on a Super Admin account. Nine characters, so every one of those rules passed it; upper case, a
 * symbol and digits, so any "complexity" rule of the usual shape would pass it too. It is also one
 * of the first passwords any guessing list tries. Length is what defeats offline guessing and a
 * denylist is what defeats the online first guess, so this asks for both and for nothing else —
 * no forced symbol, no forced digit, no expiry. Those rules push people towards exactly the
 * `Companyname@123` shape this is here to refuse.
 *
 * NOTHING HERE RUNS AT SIGN-IN. An existing password keeps working however weak it is; the rule
 * applies when a password is NEXT SET. Applying it at sign-in would lock out the people who most
 * need to get in and change it, and it would mean reading a policy decision on every login.
 *
 * NOTHING HERE EVER ECHOES THE PASSWORD. The message names the shapes it refuses, never the string
 * it was given: a validation message is rendered, logged and sometimes mailed, and a password that
 * reaches any of those places has leaked. The examples in the message are literals in this file.
 * ================================================================================================
 */

/**
 * Twelve, counted in CODE POINTS rather than UTF-16 units, so an emoji or an accented letter counts
 * once — the same counting `users.service.ts` and `password-reset.service.ts` already used for
 * their minimum, and the same the maximum uses for bytes.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** How few distinct characters makes a long password no harder to guess than a short one. */
const MIN_DISTINCT_CHARACTERS = 5;

/**
 * The roots a password may not be, or be barely more than.
 *
 * Two kinds, and the second is the one a generic list misses: the common passwords everybody's
 * list carries, and THE BROKERAGE'S OWN NAME in the spellings it actually appears in — the domain,
 * the product, the trading name. `GetHomeRealty2026` is the password a person picks when told to
 * include a capital and a digit, and no public list contains it.
 */
const WEAK_ROOTS: readonly string[] = [
  // The usual suspects, and the ones the audit named.
  'password', 'passwd', 'pass', 'admin', 'administrator', 'root', 'superadmin', 'login', 'welcome',
  'letmein', 'changeme', 'secret', 'qwerty', 'qwertyuiop', 'asdf', 'asdfgh', 'zxcv', 'abc', 'abcdef',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'master', 'shadow',
  'trustno', 'test', 'testing', 'demo', 'sample', 'default', 'temp', 'temporary', 'guest', 'user',
  // This brokerage, as it is actually written.
  'gethome', 'gethomerealty', 'homerealty', 'gethomehub', 'homehub', 'realty', 'brokerage',
  'transactiondesk', 'transaction', 'desk', 'crm',
];

/**
 * Digits and symbols people substitute for letters, folded back.
 *
 * `P@ssw0rd` is `password` to anyone guessing and should be to us. Folding is applied as an
 * ALTERNATIVE reading rather than the only one, because it cuts both ways: folding `@` to `a` turns
 * `Admin@123` into `admina123`, which no longer matches `admin`. So both readings are checked and
 * either one matching is enough — see `readings`.
 */
const LEET: Readonly<Record<string, string>> = {
  '@': 'a', '4': 'a', '8': 'b', '(': 'c', '3': 'e', '6': 'g', '1': 'i', '!': 'i', '|': 'i',
  '0': 'o', '5': 's', $: 's', '7': 't', '+': 't', '2': 'z',
};

/**
 * The ways this password might be read by somebody guessing it.
 *
 * Each reading strips the decoration that makes a weak root look like a strong password — the
 * punctuation, then the digits that were appended to satisfy a complexity rule — so that
 * `Admin@123`, `admin`, `ADMIN!!`, `admin2026` and `@dmin123` all arrive at `admin`.
 */
function readings(password: string): string[] {
  const lower = password.toLowerCase();
  const folded = [...lower].map((c) => LEET[c] ?? c).join('');
  const out = new Set<string>();

  for (const form of [lower, folded]) {
    const alnum = form.replace(/[^a-z0-9]/g, '');
    if (!alnum) continue;
    out.add(alnum);
    out.add(alnum.replace(/[0-9]/g, ''));            // the digits removed wherever they sit
    out.add(alnum.replace(/^[0-9]+|[0-9]+$/g, ''));  // only the ones wrapped around it
  }
  out.delete('');
  return [...out];
}

/**
 * The single message for every "too easy to guess" refusal.
 *
 * One wording rather than one per rule, because naming which test it failed tells somebody
 * guessing exactly which knob to turn, and tells the honest user nothing they can act on that
 * "choose a longer phrase" does not already say.
 */
const GUESSABLE =
  'The password field is too easy to guess. Avoid common passwords, the company name, '
  + 'and patterns like "Admin@123" — a short phrase of a few unrelated words is both stronger and easier to remember.';

/**
 * The problem with this password, or null when there is none.
 *
 * Returns a MESSAGE rather than throwing, because the four callers report failures in three
 * different shapes — `push()` into a field-error bag, `throwValidation()`, and a DTO — and a rule
 * that threw would have to be caught and re-thrown in most of them.
 *
 * The 72-byte ceiling is deliberately NOT here. It is a different kind of rule — a fact about what
 * bcrypt reads, not a judgement about strength — it has its own wording explaining that, and both
 * places that enforce it already had it right.
 */
export function passwordPolicyProblem(password: unknown): string | null {
  const value = String(password ?? '');
  const characters = [...value];

  if (characters.length < MIN_PASSWORD_LENGTH) {
    return `The password field must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  // All digits: a twelve-digit password is a date or a phone number, and both are public.
  if (/^[0-9]+$/.test(value)) return GUESSABLE;

  // `aaaaaaaaaaaa` and `ababababab` are long without being hard.
  if (new Set(characters).size < MIN_DISTINCT_CHARACTERS) return GUESSABLE;

  for (const reading of readings(value)) {
    for (const root of WEAK_ROOTS) {
      if (reading === root) return GUESSABLE;
      /*
       * Or barely more than the root. `admin` plus up to four characters is still `admin` to
       * somebody guessing, while `masterofpuppets` — nine characters past `master` — is a phrase
       * that happens to start with a word on the list, and refusing it would be the kind of
       * false positive that makes people write the password down.
       */
      if (reading.startsWith(root) && reading.length - root.length <= 4) return GUESSABLE;
    }
  }

  return null;
}
