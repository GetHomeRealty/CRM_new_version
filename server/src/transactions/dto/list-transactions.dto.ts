import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

const toInt = ({ value }: { value: unknown }): unknown => {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : value;
};

/**
 * Query for the transactions list.
 *
 * Every field is optional and the whole DTO is inert by default: with no `page` and no filters
 * the endpoint answers exactly as it always did — every transaction in one array, no `meta`.
 * That matters because four screens (Dashboard, Analytics, Commission, the calendar's deal
 * picker) aggregate over the full set and would silently show wrong totals if the list started
 * paginating itself underneath them.
 *
 * Field names mirror the filter controls on the transactions screen one-for-one.
 */
export class ListTransactionsDto {
  /** 1-based. Present ⇒ paginated response with `meta`; absent ⇒ the full list. */
  @IsOptional() @Transform(toInt) @IsInt() @Min(1) page?: number;

  /** Capped: this list carries every relation the row card needs, so pages stay modest. */
  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(200) per_page?: number;

  /** Free text over property, trade number and agent. */
  @IsOptional() @IsString() q?: string;

  /** Four-digit closing-date year. */
  @IsOptional() @IsString() year?: string;

  @IsOptional() @IsString() type?: string;
  /** valid_status — Pending | Valid | Invalid. */
  @IsOptional() @IsString() validation?: string;
  /** Substring of the agent name. */
  @IsOptional() @IsString() agent?: string;
  /** 'Received' | 'Not received'. */
  @IsOptional() @IsString() commission?: string;
  /** One transaction status, e.g. Open / Closed / Sold. */
  @IsOptional() @IsString() status?: string;

  @IsOptional() @IsString() offer_from?: string;
  @IsOptional() @IsString() offer_to?: string;
  @IsOptional() @IsString() closing_from?: string;
  @IsOptional() @IsString() closing_to?: string;

  /** 'Paid' | 'Pending' | 'N/A'. */
  @IsOptional() @IsString() payout?: string;
  /** Substring of any client name on the deal. */
  @IsOptional() @IsString() client?: string;
  /** Substring of the brokerage name. */
  @IsOptional() @IsString() brokerage?: string;
}
