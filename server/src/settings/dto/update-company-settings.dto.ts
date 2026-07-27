import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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

  @IsOptional() @IsNumber() @Min(0) @Max(100) default_tax_rate?: number | null;

  @IsOptional() @IsString() @MaxLength(20) invoice_prefix?: string | null;
  @IsOptional() @IsInt() @Min(1) next_invoice_no?: number | null;
  @IsOptional() @IsString() @MaxLength(50) default_terms?: string | null;
  @IsOptional() @IsString() thank_you_note?: string | null;
  @IsOptional() @IsString() deposit_heading?: string | null;

  /** Cadence (days) for recurring lawyer-detail reminders. 0 = off. Stored in feature_flags. */
  @IsOptional() @IsInt() @Min(0) @Max(365) lawyer_reminder_days?: number | null;
}
