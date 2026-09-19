import { MIN_PASSWORD_LENGTH, passwordPolicyProblem } from './password-policy';

/**
 * The password rule, written as the passwords it must refuse.
 *
 * The case that produced this file is the first one: `Admin@123` was accepted on a Super Admin
 * account in production, and every rule the application had at the time — three of them, all
 * saying eight characters — passed it. So the tests are named after the shapes rather than the
 * clauses: a rule that rejects `Admin@123` for the wrong reason is still doing its job, and one
 * that rejects a four-word passphrase is not, whatever its clauses say.
 */
describe('the password rule', () => {
  const accepted = (p: string) => expect(passwordPolicyProblem(p)).toBeNull();
  const refused = (p: string) => expect(passwordPolicyProblem(p)).toEqual(expect.any(String));

  describe('the password that caused this', () => {
    it('refuses Admin@123', () => refused('Admin@123'));

    /*
     * The point of the case, and the reason length alone is not the rule: it is NOT refused for
     * being short once it is padded out. Somebody told "at least twelve" turns Admin@123 into
     * Admin@123456, which is no harder to guess.
     */
    it('refuses it padded to the new length', () => {
      refused('Admin@123456');
      refused('Admin@1234567890');
    });

    it('refuses the rest of the first page of any guessing list', () => {
      ['Password123!', 'P@ssw0rd1234', 'Welcome@12345', 'LetMeIn123456', 'Qwerty123456', 'ChangeMe1234']
        .forEach(refused);
    });

    /*
     * The half a public denylist cannot cover. Nobody's list contains the brokerage's own name, and
     * it is the first thing a person reaches for when a form demands a capital and a digit.
     */
    it('refuses the company name in the spellings it is actually written in', () => {
      ['GetHomeRealty1', 'gethomerealty2026', 'GetHomeHub@123', 'HomeHub12345', 'Realty@2026!', 'TransactionDesk1']
        .forEach(refused);
    });
  });

  describe('what it must still accept, or people write it on a note', () => {
    it('accepts a passphrase of unrelated words', () => {
      accepted('correct horse battery staple');
      accepted('rowing-otter-kettle-9');
      accepted('Tuesday marmalade bicycle');
    });

    /*
     * A phrase that merely BEGINS with a listed word is a phrase, not that word. This is the
     * false positive that would make the rule hated, so it is pinned.
     */
    it('accepts a phrase that starts with a listed word but keeps going', () => {
      accepted('masterofpuppets1986');
      accepted('testing the water today');
      accepted('adminisnotmypasswordatall');
    });

    it('accepts a long password of ordinary characters', () => {
      accepted('Tr0ubad0ur&Vestibule');
      accepted('umbrella-forest-lantern');
    });
  });

  describe('length', () => {
    it(`refuses anything under ${MIN_PASSWORD_LENGTH} characters`, () => {
      refused('a'.repeat(MIN_PASSWORD_LENGTH - 1));
      refused('Sh0rt!');
      refused('');
    });

    it('counts code points, so an emoji counts once', () => {
      // Eleven code points that occupy more than eleven UTF-16 units: still too short.
      refused('🐈🐈🐈🐈🐈🐈🐈🐈🐈🐈🐈');
    });

    it('names the minimum in the message, because that is actionable', () => {
      expect(passwordPolicyProblem('short')).toContain(String(MIN_PASSWORD_LENGTH));
    });
  });

  describe('long but not hard', () => {
    it('refuses a password of all digits', () => {
      refused('123456789012');
      refused('20262026202620');
    });

    it('refuses too few distinct characters', () => {
      refused('aaaaaaaaaaaa');
      refused('abababababab');
    });
  });

  describe('the message', () => {
    /*
     * A validation message is rendered, logged, and on some routes mailed. A password that reaches
     * any of those has leaked, so the message may never quote what it was given — not even the
     * part that matched the denylist.
     */
    it('never echoes the password it refused', () => {
      for (const password of ['Admin@123', 'GetHomeRealty2026', 'aaaaaaaaaaaa', 'Password123!', 'Sh0rt!']) {
        const message = passwordPolicyProblem(password);
        // Asserted first, so this test cannot pass quietly by picking a password that was allowed
        // through — there would be no message to find the password in.
        expect(message).toEqual(expect.any(String));
        expect(message).not.toContain(password);
        expect(message!.toLowerCase()).not.toContain(password.toLowerCase());
      }
    });

    it('says the same thing however a password is weak, so it names no knob to turn', () => {
      const weak = ['GetHomeRealty1', '123456789012', 'aaaaaaaaaaaa', 'Password123!'];
      const messages = new Set(weak.map((p) => passwordPolicyProblem(p)));
      expect(messages.size).toBe(1);
    });
  });

  describe('input it must survive rather than throw on', () => {
    it('treats null and undefined as absent, not as a crash', () => {
      refused(undefined as unknown as string);
      refused(null as unknown as string);
    });

    it('does not refuse a long password merely for containing punctuation or spaces', () => {
      accepted('   spaced out umbrella   ');
      accepted('!!!lantern-forest-ninety!!!');
    });
  });
});
