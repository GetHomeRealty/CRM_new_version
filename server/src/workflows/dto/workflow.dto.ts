import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class EditRequestDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string | null;
  @IsOptional() @IsIn(['financial']) scope?: string | null;
}

export class DeleteRequestStoreDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) reason: string;
}

export class DeleteRequestForwardDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string | null;
}
