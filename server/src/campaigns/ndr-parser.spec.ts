import { parseNdr } from './ndr-parser';

/**
 * Reading a bounce that arrives as an email.
 *
 * THE REPORTED BUG. A campaign to `karishma@gmail.co` showed "Sent" and then "Opened". The domain
 * `gmail.co` resolves — `.co` is a real TLD — so Gmail's relay accepted the message with 250 OK and
 * reported the failure minutes later as a Non-Delivery Report. Nothing read NDRs, so the recipient
 * stayed `sent`, and because `recordOpen` only refuses a recipient ALREADY marked bounced, its
 * guard had nothing to act on when a pixel was later fetched.
 *
 * THE RISK IN FIXING IT is the opposite of the bug: marking a live recipient as bounced suppresses
 * their address and stops the brokerage mailing a real client. A miss leaves a wrong status; a false
 * positive silently removes somebody from every future campaign. These tests spend most of their
 * length on what must NOT be read as a bounce.
 */

const gmailNdr = {
  from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  subject: 'Delivery Status Notification (Failure)',
  text: [
    '** Address not found **',
    "Your message wasn't delivered to karishma@gmail.co because the address couldn't be found, or is unable to receive mail.",
    '',
    'The response from the remote server was:',
    '550 5.1.1 The email account that you tried to reach does not exist.',
  ].join('\n'),
  html: null,
};

const rfc3464Ndr = {
  from: 'postmaster@example.net',
  subject: 'Undelivered Mail Returned to Sender',
  text: [
    'This is the mail system at host example.net.',
    '',
    'Content-Type: message/delivery-status',
    '',
    'Final-Recipient: rfc822; nobody@example.net',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 <nobody@example.net>: Recipient address rejected: User unknown',
  ].join('\n'),
  html: null,
};

describe('reading a delivery report', () => {
  it('reads Gmail\'s human-readable failure and names the right address', () => {
    const v = parseNdr(gmailNdr);
    expect(v.isNdr).toBe(true);
    expect(v.addresses).toEqual(['karishma@gmail.co']);
    expect(v.type).toBe('hard');
  });

  it('prefers the machine-readable Final-Recipient when the report has one', () => {
    const v = parseNdr(rfc3464Ndr);
    expect(v.isNdr).toBe(true);
    expect(v.addresses).toEqual(['nobody@example.net']);
    expect(v.type).toBe('hard');
  });

  it('separates a soft bounce from a hard one', () => {
    const v = parseNdr({
      from: 'mailer-daemon@example.net',
      subject: 'Delivery Status Notification (Delay)',
      text: 'Final-Recipient: rfc822; busy@example.net\n452 4.2.2 The email account that you tried to reach is over quota.',
      html: null,
    });
    expect(v.isNdr).toBe(true);
    expect(v.type).toBe('soft');
    expect(v.addresses).toEqual(['busy@example.net']);
  });

  it('reads a report delivered as HTML only', () => {
    const v = parseNdr({
      from: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      text: null,
      html: "<div>Your message wasn't delivered to <a>ghost@example.org</a> because the address couldn't be found.</div>"
        + '<pre>550 5.1.1 user unknown</pre>',
    });
    expect(v.isNdr).toBe(true);
    expect(v.addresses).toEqual(['ghost@example.org']);
  });
});

describe('what must NOT be read as a bounce', () => {
  it('an ordinary reply from a client', () => {
    expect(parseNdr({
      from: 'client@example.com', subject: 'Re: Your property search',
      text: 'Thanks, that looks great. Can we view it on Saturday?', html: null,
    }).isNdr).toBe(false);
  });

  it('a message that merely mentions the word undeliverable', () => {
    expect(parseNdr({
      from: 'colleague@gethomerealty.ca', subject: 'FW: undeliverable addresses to clean up',
      text: 'Here is the list we should remove: old@example.com', html: null,
    }).isNdr).toBe(false);
  });

  it('an out-of-office auto-reply, which comes from a daemon-ish sender but is not a failure', () => {
    expect(parseNdr({
      from: 'no-reply@example.com', subject: 'Automatic reply: Your property search',
      text: 'I am out of the office until Monday.', html: null,
    }).isNdr).toBe(false);
  });

  it('a report whose failure cannot be read — guessing would suppress a live address', () => {
    expect(parseNdr({
      from: 'mailer-daemon@example.net', subject: 'Delivery Status Notification',
      text: 'Something happened to your message.', html: null,
    }).isNdr).toBe(false);
  });

  it('a failure at OUR end, which says nothing about the address', () => {
    /*
     * "535 BadCredentials" is a 5xx, and reading it as a permanent rejection would suppress every
     * address in the campaign because of one expired password. `classifyBounce` answers `unknown`
     * for our own faults, and `unknown` is not acted on.
     */
    expect(parseNdr({
      from: 'mailer-daemon@example.net', subject: 'Delivery failure',
      text: 'Final-Recipient: rfc822; real@example.com\n535 5.7.8 BadCredentials — authentication failed',
      html: null,
    }).isNdr).toBe(false);
  });

  it('never names the daemon or postmaster as the bounced party', () => {
    const v = parseNdr({
      from: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      text: "Your message wasn't delivered to mailer-daemon@googlemail.com because the address couldn't be found."
        + '\n550 5.1.1 user unknown',
      html: null,
    });
    expect(v.addresses).not.toContain('mailer-daemon@googlemail.com');
  });

  it('does not harvest every address in the quoted original message', () => {
    /*
     * The body of a bounce usually quotes the whole original email — signature, unsubscribe footer,
     * the agent's own address. Collecting those would suppress the brokerage's own mailboxes.
     */
    const v = parseNdr({
      from: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      text: [
        "Your message wasn't delivered to karishma@gmail.co because the address couldn't be found.",
        '550 5.1.1 user unknown',
        '----- Original message -----',
        'From: precon@gethomerealty.ca',
        'To: karishma@gmail.co',
        'Reply to info@gethomerealty.ca or visit our site. Unsubscribe: unsub@gethomerealty.ca',
      ].join('\n'),
      html: null,
    });
    expect(v.addresses).toEqual(['karishma@gmail.co']);
  });

  it('an empty or absent message', () => {
    expect(parseNdr({}).isNdr).toBe(false);
    expect(parseNdr({ from: null, subject: null, text: null, html: null }).isNdr).toBe(false);
  });
});
