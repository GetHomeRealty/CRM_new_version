import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { deflateRawSync } from 'node:zlib';
import { TransactionImportService } from './transaction-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';

/**
 * TD-099 — reading an uploaded workbook, and saying what went wrong when it cannot be read.
 *
 * THE REPORTED HALF — a workbook whose text is stored as INLINE STRINGS (what openpyxl and pandas
 * write: `<c t="inlineStr"><is><t>…</t></is></c>`, with no `xl/sharedStrings.xml` part at all) was
 * refused while the identical content stored as shared strings was accepted. It reads correctly
 * now, and the first test is the matched pair that proves it: same headings, same row, differing
 * only in how the text is stored. That pair is the only way this question can be decided — anything
 * else leaves sheet count, headings and layout detection as alternative explanations.
 *
 * THE HALF THAT WAS STILL OPEN — every unreadable upload answered with one sentence: "The file
 * could not be read as an Excel workbook. Re-save it as .xlsx and try again." Right advice for the
 * common causes, useless to the operator whose file already IS a valid .xlsx, because it names
 * nothing to change. A brokerage migrating its book writes that file from a script, and "re-save it
 * as .xlsx" describes what they just did.
 *
 * So the message now says which of the common causes the bytes look like. The advice is kept — it
 * is still the right next step — but it follows a sentence that says why.
 *
 * No database: reading a file is a pure function of the file.
 */

const service = new TransactionImportService(
  {} as unknown as PrismaService,
  {} as unknown as TransactionsWriteService,
);

const parse = (name: string, buffer: Buffer): Promise<unknown> =>
  (service as unknown as { parseFile(n: string, b: Buffer): Promise<unknown> }).parseFile(name, buffer);

const refusal = async (name: string, buffer: Buffer): Promise<string> => {
  try {
    await parse(name, buffer);
    return '(accepted)';
  } catch (e) {
    if (e instanceof BadRequestException) return String((e.getResponse() as { message?: string }).message ?? '');
    throw e;
  }
};

const HEADERS = ['Transaction Type', 'Property Address', 'Deal Status'];
const ROW = ['Residential Buying', '1 ZZ-TEST Road', 'Secured Firm'];

/** A workbook written by ExcelJS — shared strings, the way Excel and the app's own template write. */
async function sharedStringsWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Transactions');
  ws.addRow(HEADERS);
  ws.addRow(ROW);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The same content as an openpyxl-style workbook: every cell `t="inlineStr"`, no sharedStrings
 * part, and `[Content_Types].xml` written LAST — all four of the differences the entry lists as
 * candidate causes, in one file.
 */
/** The worksheet part this fixture writes, so its shape can be asserted before it is compressed. */
function inlineSheetXml(): string {
  const cell = (col: number, row: number, text: string): string =>
    `<c r="${String.fromCharCode(64 + col)}${row}" t="inlineStr"><is><t>${text}</t></is></c>`;
  const rowXml = (values: string[], row: number): string =>
    `<row r="${row}">${values.map((v, i) => cell(i + 1, row, v)).join('')}</row>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + rowXml(HEADERS, 1) + rowXml(ROW, 2)
    + '</sheetData></worksheet>';
}

function inlineStringsWorkbook(): Buffer {
  const cell = (col: number, row: number, text: string): string => {
    const ref = `${String.fromCharCode(64 + col)}${row}`;
    return `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  };
  const rowXml = (values: string[], row: number): string =>
    `<row r="${row}">${values.map((v, i) => cell(i + 1, row, v)).join('')}</row>`;

  const files: [string, string][] = [
    ['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'],
    ['xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>'],
    ['xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + rowXml(HEADERS, 1) + rowXml(ROW, 2)
      + '</sheetData></worksheet>'],
    // Deliberately last, which is one of the four differences the entry lists.
    ['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>'],
  ];
  return zip(files);
}

/** A minimal ZIP writer: enough of the format for a reader to open, with no dependency added. */
function zip(files: [string, string][]): Buffer {
  const crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);   // version made by
    central.writeUInt16LE(20, 6);   // version needed
    central.writeUInt16LE(0, 8);    // flags
    // The compression METHOD lives at 10 in a central record and at 8 in a local one. Writing 8
    // here put "deflate" in the flags and left the method as "stored", and the reader then failed
    // with "uncompressed data size mismatch" — a fixture bug that reads exactly like a corrupt file.
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

describe('the importer reads a workbook however its text is stored (TD-099)', () => {
  it('reads inline strings and shared strings identically — the matched pair', async () => {
    const inline = inlineStringsWorkbook();
    /*
     * The file really is the reported shape. The cell markup is asserted on the XML this fixture
     * writes — inside the zip it is DEFLATE-compressed, so the bytes do not contain the marker —
     * while the ABSENCE of a shared-strings part is assertable on the buffer, because zip entry
     * NAMES are stored uncompressed in the headers.
     */
    expect(inlineSheetXml()).toContain('t="inlineStr"');
    expect(inlineSheetXml()).not.toContain('sharedStrings');
    expect(inline.includes('sharedStrings.xml')).toBe(false);

    const fromInline = await parse('openpyxl.xlsx', inline);
    const fromShared = await parse('excel.xlsx', await sharedStringsWorkbook());
    expect(fromInline).toEqual(fromShared);
  });
});

describe('an unreadable upload is told what is wrong with it (TD-099)', () => {
  it('names a legacy .xls wearing an .xlsx name', async () => {
    const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    const message = await refusal('book.xlsx', ole2);
    expect(message).toContain('legacy .xls');
    // The advice that was the whole message before is kept — it is still the next step.
    expect(message).toContain('Save As');
  });

  it('names a CSV that has been renamed', async () => {
    const csv = Buffer.from('Transaction Type,Property Address\nResidential Buying,1 ZZ-TEST Road\n', 'utf8');
    const message = await refusal('renamed.xlsx', csv);
    expect(message).toContain('plain text');
    expect(message).toContain('.csv');
  });

  it('names a truncated or foreign binary', async () => {
    const message = await refusal('broken.xlsx', Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
    expect(message).toContain('ZIP container');
  });

  it('names a ZIP that holds no workbook', async () => {
    const archive = zip([['readme.txt', 'not a workbook']]);
    const message = await refusal('archive.xlsx', archive);
    expect(message).toContain('xl/workbook.xml');
  });

  it('quotes the reader when the file IS an xlsx and still will not open', async () => {
    // A workbook part present but corrupt: the operator whose file is genuinely an .xlsx gets the
    // reader's own words instead of being told to do what they already did.
    const corrupt = zip([['xl/workbook.xml', '<workbook><sheets><sheet'], ['[Content_Types].xml', '<Types/>']]);
    const message = await refusal('corrupt.xlsx', corrupt);
    expect(message).toContain('could not be read');
    expect(message).not.toBe('The file could not be read as an Excel workbook. Re-save it as .xlsx and try again.');
  });

  it('still names the two file types it refuses outright', async () => {
    expect(await refusal('book.xls', Buffer.alloc(16))).toContain('legacy .xls format');
    expect(await refusal('book.pdf', Buffer.alloc(16))).toContain('Unsupported file type');
  });
});
