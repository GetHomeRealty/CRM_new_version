import * as Picker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { validateImport } from './lead-import-api';

export async function chooseImportCsv(): Promise<{ name: string; csv: string } | null> {
  const result = await Picker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'public.comma-separated-values-text'], multiple: false, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset || !/\.csv$/i.test(asset.name)) throw new Error('Choose a .csv file.');
  const file = new File(asset.uri);
  if (!file.exists || file.size <= 0 || file.size > 1024 * 1024) throw new Error('Choose a CSV file smaller than 1 MB.');
  const csv = (await file.text()).replace(/^\uFEFF/, '');
  validateImport(csv, '');
  return { name: asset.name, csv };
}
