import { loadJsPdf } from './heavyLibs';
import type { MlsProperty } from '../lib/mlsApi';

/** A field to render on the detail page: the RESO key + a human label + optional prefix/suffix. */
export interface PropertyField {
  key: string;
  label: string;
  prefix?: string;
  suffix?: string;
}

/** RESO fields grouped into sections (ported from the source detail page). */
export const PROPERTY_GROUPS: Record<string, PropertyField[]> = {
  'Basic Info': [
    { key: 'ListPrice', label: 'List Price', prefix: '$' },
    { key: 'BedroomsTotal', label: 'Bedrooms' },
    { key: 'BathroomsTotalInteger', label: 'Bathrooms' },
    { key: 'LivingArea', label: 'Living Area', suffix: 'sqft' },
    { key: 'PropertyType', label: 'Property Type' },
    { key: 'PropertySubType', label: 'Property Sub Type' },
    { key: 'StandardStatus', label: 'Status' },
    { key: 'PropertyCondition', label: 'Condition' },
  ],
  Location: [
    { key: 'UnparsedAddress', label: 'Address' },
    { key: 'City', label: 'City' },
    { key: 'StateOrProvince', label: 'Province' },
    { key: 'PostalCode', label: 'Postal Code' },
    { key: 'CountyOrParish', label: 'County' },
    { key: 'MLSAreaMajor', label: 'MLS Area' },
    { key: 'Subdivision', label: 'Subdivision' },
  ],
  'Property Details': [
    { key: 'YearBuilt', label: 'Year Built' },
    { key: 'LotSizeArea', label: 'Lot Size', suffix: 'sqft' },
    { key: 'LotSizeUnits', label: 'Lot Size Units' },
    { key: 'StoriesTotal', label: 'Stories' },
    { key: 'RoomsTotal', label: 'Total Rooms' },
    { key: 'BedroomsPossible', label: 'Possible Bedrooms' },
    { key: 'BathroomsFull', label: 'Full Bathrooms' },
    { key: 'BathroomsHalf', label: 'Half Bathrooms' },
    { key: 'BathroomsThreeQuarter', label: '3/4 Bathrooms' },
  ],
  'Parking & Garage': [
    { key: 'ParkingTotal', label: 'Total Parking' },
    { key: 'GarageSpaces', label: 'Garage Spaces' },
    { key: 'CarportSpaces', label: 'Carport Spaces' },
    { key: 'CoveredSpaces', label: 'Covered Spaces' },
    { key: 'ParkingFeatures', label: 'Parking Features' },
  ],
  'Construction & Structure': [
    { key: 'ConstructionMaterials', label: 'Construction Materials' },
    { key: 'Foundation', label: 'Foundation' },
    { key: 'Roof', label: 'Roof' },
    { key: 'RoofMaterial', label: 'Roof Material' },
    { key: 'ExteriorFeatures', label: 'Exterior Features' },
    { key: 'InteriorFeatures', label: 'Interior Features' },
    { key: 'Flooring', label: 'Flooring' },
  ],
  'Systems & Utilities': [
    { key: 'Heating', label: 'Heating' },
    { key: 'Cooling', label: 'Cooling' },
    { key: 'WaterSource', label: 'Water Source' },
    { key: 'SewerSeptic', label: 'Sewer/Septic' },
    { key: 'Electric', label: 'Electric' },
    { key: 'Utilities', label: 'Utilities' },
  ],
  'Financial Details': [
    { key: 'OriginalListPrice', label: 'Original Price', prefix: '$' },
    { key: 'TaxAssessedValue', label: 'Tax Assessment', prefix: '$' },
    { key: 'TaxAnnualAmount', label: 'Annual Tax', prefix: '$' },
    { key: 'AssociationFee', label: 'Maintenance Fee', prefix: '$' },
    { key: 'AssociationFeeFrequency', label: 'Fee Frequency' },
    { key: 'AssociationName', label: 'Association Name' },
  ],
  'Listing Details': [
    { key: 'ListingKey', label: 'MLS #' },
    { key: 'ListAgentFullName', label: 'Listing Agent' },
    { key: 'ListAgentEmail', label: 'Agent Email' },
    { key: 'ListAgentPhone', label: 'Agent Phone' },
    { key: 'ListOfficeName', label: 'Listing Office' },
  ],
  'Important Dates': [
    { key: 'ListDate', label: 'List Date' },
    { key: 'ModificationTimestamp', label: 'Last Updated' },
    { key: 'CloseDate', label: 'Close Date' },
  ],
};

/** Fields kept on a favorite snapshot so the Favorites page renders without re-fetching MLS. */
export function snapshotOf(p: MlsProperty): MlsProperty {
  const keys = [
    'ListingKey', 'UnparsedAddress', 'City', 'StateOrProvince', 'PostalCode',
    'ListPrice', 'BedroomsTotal', 'BathroomsTotalInteger', 'LivingArea', 'PropertyType', 'StandardStatus',
  ];
  const out: MlsProperty = {};
  for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

export function fmtValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'N/A';
  if (typeof value === 'number') return value.toLocaleString('en-CA');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-CA') : 'N/A';
}

/**
 * Build and download a property report PDF from a full MLS listing (ported, CAD/en-CA).
 *
 * Asynchronous only because jsPDF is now fetched on demand — roughly 111 kB gzipped that no
 * longer loads for people who never export a listing. The work itself is unchanged.
 */
export async function downloadPropertyPdf(property: MlsProperty): Promise<void> {
  const JsPDF = await loadJsPdf();
  const doc = new JsPDF();
  let y = 20;
  const currency = (v: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(v);
  const date = (s: string) => (s ? new Date(s).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A');

  const section = (title: string, rows: [string, unknown][], startY: number): number => {
    if (!rows.some(([, v]) => v !== undefined && v !== null && v !== '')) return startY;
    doc.setFontSize(15); doc.setTextColor(220, 38, 38); doc.text(title, 20, startY);
    let cy = startY + 12; doc.setFontSize(11); doc.setTextColor(60, 60, 60);
    for (const [k, v] of rows) {
      if (v === undefined || v === null || v === '') continue;
      let text: string;
      if (typeof v === 'number') text = k.toLowerCase().includes('price') ? currency(v) : k.toLowerCase().includes('area') || k.toLowerCase().includes('size') ? `${v.toLocaleString('en-CA')} sqft` : v.toLocaleString('en-CA');
      else if (typeof v === 'boolean') text = v ? 'Yes' : 'No';
      else if (typeof v === 'string' && (k.toLowerCase().includes('date') || k.toLowerCase().includes('timestamp'))) text = date(v);
      else text = String(v);
      const lines = doc.splitTextToSize(text, 95) as string[];
      doc.text(`${k}:`, 22, cy);
      doc.text(lines, 90, cy);
      cy += 7 * Math.max(1, lines.length);
      if (cy > 275) { doc.addPage(); cy = 20; }
    }
    return cy + 8;
  };

  doc.setFontSize(22); doc.setTextColor(220, 38, 38); doc.text('Property Report', 20, y);
  y = 38; doc.setFontSize(16); doc.setTextColor(0, 0, 0);
  doc.text(String(property.UnparsedAddress ?? 'Property'), 20, y);
  y = 47; doc.setFontSize(11);
  doc.text([property.City, property.StateOrProvince, property.PostalCode].filter(Boolean).join(', '), 20, y);
  y += 14;

  const p = property as Record<string, unknown>;
  const sections: [string, [string, unknown][]][] = [
    ['Property Overview', [['List Price', p.ListPrice], ['Status', p.StandardStatus], ['Property Type', p.PropertyType], ['Year Built', p.YearBuilt], ['Living Area', p.LivingArea]]],
    ['Interior', [['Bedrooms', p.BedroomsTotal], ['Bathrooms', p.BathroomsTotalInteger], ['Interior Features', p.InteriorFeatures], ['Flooring', p.Flooring]]],
    ['Exterior & Construction', [['Construction', p.ConstructionMaterials], ['Exterior Features', p.ExteriorFeatures], ['Roof', p.RoofMaterial ?? p.Roof], ['Foundation', p.Foundation]]],
    ['Systems & Utilities', [['Cooling', p.Cooling], ['Heating', p.Heating], ['Utilities', p.Utilities], ['Water Source', p.WaterSource]]],
    ['Parking', [['Garage Spaces', p.GarageSpaces], ['Total Parking', p.ParkingTotal], ['Parking Features', p.ParkingFeatures]]],
    ['Financial', [['Annual Tax', p.TaxAnnualAmount], ['Tax Assessment', p.TaxAssessedValue], ['Maintenance Fee', p.AssociationFee]]],
    ['Listing', [['MLS #', p.ListingKey], ['List Date', p.ListDate], ['Last Modified', p.ModificationTimestamp], ['Listing Agent', p.ListAgentFullName]]],
  ];
  for (const [title, rows] of sections) {
    if (y > 250) { doc.addPage(); y = 20; }
    y = section(title, rows, y);
  }

  doc.setFontSize(9); doc.setTextColor(150, 150, 150);
  doc.text('Generated by Get Home Realty', 20, 288);
  doc.text(`MLS #: ${property.ListingKey ?? ''} · ${new Date().toLocaleString('en-CA')}`, 20, 293);
  doc.save(`property-${property.ListingKey ?? 'listing'}.pdf`);
}
