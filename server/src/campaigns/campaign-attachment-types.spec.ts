import { attachmentTypeProblem } from './campaign-templates.service';

/**
 * U-1 - a campaign attachment rides along with every send of its template, to real clients.
 * What may be attached is therefore the same question as what may be filed as a document.
 */
describe('what may be attached to a campaign', () => {
  const ok = (f: string, t = 'application/pdf') => expect(attachmentTypeProblem(f, t)).toBeNull();
  const no = (f: string, t = 'application/octet-stream') => expect(attachmentTypeProblem(f, t)).toMatch(/not accepted/);

  it('accepts the things a brokerage actually sends', () => {
    ok('Listing Package.pdf');
    ok('photo.jpg', 'image/jpeg');
    ok('numbers.xlsx', 'application/vnd.ms-excel');
  });

  it('refuses a page that can carry script', () => no('welcome.html'));
  it('refuses a drawing that can carry script', () => no('logo.svg'));
  it('refuses a program', () => no('setup.exe'));
  it('refuses a file with no extension at all', () => no('attachment'));

  it('refuses a dangerous declared type even when the name looks safe', () => {
    expect(attachmentTypeProblem('safe-looking.pdf', 'text/html')).toMatch(/not accepted/);
  });

  it('names what IS allowed, so the person can fix it', () => {
    expect(attachmentTypeProblem('x.exe', 'application/octet-stream')).toMatch(/\.pdf/);
  });
});
