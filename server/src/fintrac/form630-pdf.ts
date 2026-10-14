import { PDFDocument, PDFName, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, StandardFonts } from 'pdf-lib';
import { promises as fs } from 'fs';
import * as path from 'path';
import { UnprocessableEntityException } from '@nestjs/common';
export const FORM630_FIELDS = ['full_legal_name','address','dob','occupation','id_type','id_number','issuing_jurisdiction','country','expiry_date'] as const;
export type Form630Identity = Record<typeof FORM630_FIELDS[number], string>;
const dmy = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8,10)}-${v.slice(5,7)}-${v.slice(0,4)}` : v;
export async function makeForm630(identity: Form630Identity, context: {property: string; agent: string; date_verified: string}) {
 const pdf = await PDFDocument.load(await fs.readFile(path.join(__dirname, 'assets/individual-identification-630.pdf')));
 const form = pdf.getForm(), font = await pdf.embedFont(StandardFonts.Helvetica);
 // Never inherit template answers for another client, especially risk/third-party declarations.
 for(const field of form.getFields()) {
  if(field instanceof PDFTextField) {field.setText('');field.updateAppearances(font);}
  else if(field instanceof PDFCheckBox) {field.uncheck();field.updateAppearances();}
  else if(field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) field.clear();
 }
 const values: Record<string,string> = {txtIndividual:identity.full_legal_name,txtstreet:identity.address,txtBirthDate:dmy(identity.dob),txtOccupation:identity.occupation,txtDocumentIDNum:identity.id_number,txtIssuingJurisdiction:identity.issuing_jurisdiction,txtFedCountry:identity.country,txtDocExpDate:dmy(identity.expiry_date),txtp_street:context.property,txtbroker:context.agent,txtInfoVerDate:dmy(context.date_verified)};
 for(const [key,value] of Object.entries(values)) {
  const field=form.getTextField(key), widget=field.acroField.getWidgets()[0], width=widget.getRectangle().width;
  if(key==='txtDocumentIDNum') widget.setRectangle({...widget.getRectangle(),y:widget.getRectangle().y-3});
  try {font.encodeText(value);} catch {throw new UnprocessableEntityException({message:'This form template cannot render one of the entered characters. Edit the value before exporting.'});}
  if(value.length>(field.getMaxLength()??500)) throw new UnprocessableEntityException({message:'A value is too long for the Form 630 field. Shorten it before exporting.'});
  const measured=value?font.widthOfTextAtSize(value,9):0;const size=measured?Math.min(9,(width-4)/measured*9):9;
  if(size<6) throw new UnprocessableEntityException({message:'A value will not fit legibly on Form 630. Shorten it before exporting.'});
  field.setText(value);field.setFontSize(size);field.updateAppearances(font);
 }
 // The supplied template represents its three mutually exclusive ID widgets as one checkbox.
 const selector=form.getCheckBox('chkOpt_Type');selector.updateAppearances();
 const option=identity.id_type==="Driver's Licence"?'1':identity.id_type==='Passport'?'2':identity.id_type==='Other'?'3':'Off';
 selector.acroField.dict.set(PDFName.of('V'),PDFName.of(option));
 for(const widget of selector.acroField.getWidgets()) widget.setAppearanceState(widget.getOnValue()?.asString()===`/${option}`?PDFName.of(option):PDFName.of('Off'));
 return Buffer.from(await pdf.save({updateFieldAppearances:false}));
}
