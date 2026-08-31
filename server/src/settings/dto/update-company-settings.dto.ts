import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * The currencies an invoice may be denominated in.
 *
 * This column was `@MaxLength(8)` and nothing else, so it took free text: `BITCOIN!`, `𝔘𝔫𝔦` and an
 * empty string were all accepted with 200 on 2026-08-04. It is printed on every Invoice, Deposit
 * Receipt and commission statement, which makes it the one currency field in the application that
 * has to be a real currency — while the CRM Settings currency *preference*, which is read by
 * nothing, was correctly allow-listed. The validation was on the field that does nothing and absent
 * from the field that prints on money.
 *
 * ISO 4217 codes, kept to the ones a Canadian brokerage plausibly bills in. Adding one is a line
 * here; the point is that it is a decision rather than a typo.
 */
export const INVOICE_CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'INR', 'AED'] as const;

/**
 * Postgres `int4`. `next_invoice_no` had `@Min(1)` and no ceiling, so 2147483648 passed validation,
 * reached the column and came back as a bare 500 — a raw stack-trace status code from a numeric
 * field on an administrator's form.
 */
const INT4_MAX = 2147483647;

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

/**
 * Strip surrounding whitespace from every text field before it is validated or stored.
 *
 * `"  Padded Brokerage  "` was stored verbatim (measured 2026-08-03) and then printed, with its
 * padding, on invoices and deposit receipts. The Users module was fixed for exactly this (U-M1) and
 * Settings was not.
 *
 * It runs BEFORE validation, which is the point: a name of three spaces used to pass `@IsNotEmpty`,
 * reach the column and become the brokerage's name. Trimmed first, it is refused with the message
 * the field already has. Length limits then measure the value that is actually stored, rather than
 * the padding around it.
 */
const trimmed = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

/**
 * A permissive address shape. `@IsEmail()` would refuse an empty string, and clearing this box is
 * how you unset the field — `@IsOptional()` only skips `undefined` and `null`.
 *
 * The field had NO format check at all: `"not-an-email"` was accepted and stored (2026-08-03), and
 * it prints on client-facing invoices and receipts as the brokerage's contact address.
 */
const EMAIL_OR_BLANK = /^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors CompanySettingController::update validation. Only present fields are saved. */
export class UpdateCompanySettingsDto {
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(255) address?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(50) phone?: string | null;

  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(255)
  @Matches(EMAIL_OR_BLANK, { message: 'email must be a valid email address, or empty to clear it' })
  email?: string | null;

  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(100) hst_number?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(255) bank_beneficiary?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(100) bank_name?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(50) transit_no?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(50) account_no?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(50) institution_no?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() @IsIn(INVOICE_CURRENCIES as unknown as string[], {
    message: `currency must be one of ${INVOICE_CURRENCIES.join(', ')}`,
  }) currency?: string | null;

  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(100) default_tax_rate?: number | null;

  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(20) invoice_prefix?: string | null;
  @IsOptional() @Transform(toNumber) @IsInt() @Min(1) @Max(INT4_MAX) next_invoice_no?: number | null;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(50) default_terms?: string | null;

  /*
   * These two were `@IsString()` with no ceiling at all, against `Text` columns — 100,000 characters
   * were accepted with 200 on 2026-08-04. They print on an invoice and a deposit receipt, so the
   * practical limit is a short paragraph.
   *
   * The bound is enforced in the SERVICE, not here, and only against values that actually changed.
   * A ceiling applied here would reject a legacy value the moment anybody opened the form: the
   * screen loads the whole row and posts it back, so one over-long note left by the unbounded
   * version would 422 every save of every other field — the administrator could no longer change
   * the phone number, and nothing on screen would say why. Caught while testing this very change.
   * See `assertNotesWithinLimit`.
   */
  @IsOptional() @Transform(trimmed) @IsString() thank_you_note?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() deposit_heading?: string | null;
  @IsOptional() @Transform(trimmed) @IsString() deposit_signatory?: string | null;

  /** Cadence (days) for recurring lawyer-detail reminders. 0 = off. Stored in feature_flags. */
  @IsOptional() @IsInt() @Min(0) @Max(365) lawyer_reminder_days?: number | null;

  /**
   * The `updated_at` the editor loaded, echoed back so a stale save can be refused.
   *
   * Two people holding the same loaded row both saved and both got 200; the second silently
   * discarded the first's work and neither was told (measured 2026-08-04). Optional, so an API
   * client that does not send it behaves exactly as before — the screen always sends it, which is
   * where two administrators tidying the company profile on the same afternoon actually collide.
   */
  @IsOptional() @IsString() expected_updated_at?: string | null;
}
