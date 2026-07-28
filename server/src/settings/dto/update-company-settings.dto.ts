import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Decimal columns are serialized as fixed-point STRINGS ("13.00") to match Laravel's
 * decimal cast, so the settings screen loads a string and sends that same string back on
 * save. Implicit conversion can't help — the property is `number | null`, whose emitted
 * design type is Object — so the value has to be coerced explicitly or every save fails
 * with "must be a number conforming to the specified constraints".
 */
const toNumber = ({ value }: { value: unknown }): unknown => {
  // Clearing the field in the UI sends ''. Both these columns are NOT NULL, so an empty
  // box means "leave it as it is" — undefined drops the key, and update() only writes
  // the keys actually present.
  if (value === '' || value === null || value === undefined) return undefined;
  return Number(value);
};

/** Mirrors CompanySettingController::update validation. Only present fields are saved. */
export class UpdateCompanySettingsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsOptional() @IsString() @MaxLength(255) address?: string | null;
  @IsOptional() @IsString() @MaxLength(50) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(255) email?: string | null;
  @IsOptional() @IsString() @MaxLength(100) hst_number?: string | null;
  @IsOptional() @IsString() @MaxLength(255) bank_beneficiary?: string | null;
  @IsOptional() @IsString() @MaxLength(100) bank_name?: string | null;
  @IsOptional() @IsString() @MaxLength(50) transit_no?: string | null;
  @IsOptional() @IsString() @MaxLength(50) account_no?: string | null;
  @IsOptional() @IsString() @MaxLength(50) institution_no?: string | null;
  @IsOptional() @IsString() @MaxLength(8) currency?: string | null;

  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(100) default_tax_rate?: number | null;

  @IsOptional() @IsString() @MaxLength(20) invoice_prefix?: string | null;
  @IsOptional() @Transform(toNumber) @IsInt() @Min(1) next_invoice_no?: number | null;
  @IsOptional() @IsString() @MaxLength(50) default_terms?: string | null;
  @IsOptional() @IsString() thank_you_note?: string | null;
  @IsOptional() @IsString() deposit_heading?: string | null;
}
