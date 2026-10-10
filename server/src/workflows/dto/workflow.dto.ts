import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, IsObject } from 'class-validator';

export class EditRequestDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string | null;
  @IsOptional() @IsIn(['financial', 'commission']) scope?: string | null;

  /**
   * The commission values being proposed, for `scope: 'commission'`.
   *
   * Validated in the service rather than here, against `COMMISSION_PROPOSABLE`: the allowed keys
   * are a property of the workflow that applies them, and a second list in a DTO would be a second
   * place for them to drift.
   */
  @IsOptional() @IsObject() proposed?: Record<string, unknown> | null;
}

export class DeleteRequestStoreDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) reason: string;
}

export class DeleteRequestForwardDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string | null;
}
