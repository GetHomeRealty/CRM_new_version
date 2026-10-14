import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import * as Sharing from 'expo-sharing';
import { leadExportCsv } from './lead-bulk-api';

export async function shareLeadExport(rows: readonly Record<string, string>[]): Promise<void> {
  if (!rows.length) throw new Error('No eligible leads were returned for export.');
  if (!await Sharing.isAvailableAsync()) throw new Error('Sharing is not available on this device.');
  const directory = new Directory(Paths.cache, `hub-lead-export-${Crypto.randomUUID()}`);
  try {
    directory.create();
    const file = new File(directory, 'selected-leads.csv');
    file.write('\uFEFF' + leadExportCsv(rows));
    await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle: 'Export selected leads' });
  } finally { if (directory.exists) directory.delete(); }
}
