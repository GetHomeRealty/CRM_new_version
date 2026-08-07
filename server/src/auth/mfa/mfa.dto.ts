import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min, MinLength } from 'class-validator';

/**
 * Request shapes for the two-factor endpoints.
 *
 * The validation here is about SHAPE, not about secrets — whether a code is correct is decided by
 * the service against stored state, and a validator that rejected a wrong-length code with a
 * different message from a wrong code would leak the format of something it should not describe.
 * Lengths are therefore generous and only exclude what cannot possibly be a code.
 */

export class BeginOtpEnrolmentDto {
  @IsIn(['email', 'sms'])
  channel!: 'email' | 'sms';

  @IsString()
  @Length(3, 255)
  destination!: string;
}

export class ConfirmEnrolmentDto {
  @IsIn(['totp', 'email', 'sms'])
  type!: 'totp' | 'email' | 'sms';

  @IsString()
  @Length(1, 32)
  code!: string;
}

export class RemoveMethodDto {
  @IsIn(['totp', 'email', 'sms'])
  type!: 'totp' | 'email' | 'sms';

  /** Removing a factor is as consequential as adding one, so it costs the account password. */
  @IsString()
  @MinLength(1)
  password!: string;
}

export class PasswordOnlyDto {
  @IsString()
  @MinLength(1)
  password!: string;
}

export class ChallengeDto {
  @IsIn(['totp', 'email', 'sms', 'recovery'])
  method!: 'totp' | 'email' | 'sms' | 'recovery';

  @IsString()
  @Length(1, 64)
  code!: string;

  /** "Do not ask again on this device." Absent is false — trusting must be chosen, never defaulted. */
  @IsOptional()
  @IsBoolean()
  trust_device?: boolean;
}

export class SendChallengeCodeDto {
  @IsIn(['email', 'sms'])
  channel!: 'email' | 'sms';
}

export class SetPolicyDto {
  @IsString()
  @Length(1, 64)
  role!: string;

  @IsBoolean()
  required!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  grace_days?: number;
}
