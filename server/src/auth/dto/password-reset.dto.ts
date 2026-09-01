import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

/**
 * Ask for a reset link.
 *
 * NOT `@IsEmail`, deliberately. Signing in accepts a username or an email, and on this deployment
 * they differ on most accounts — so validating this as an email would reject the very thing a
 * locked-out person is most likely to type, and reject it with a message that implies they used the
 * wrong address rather than the wrong field.
 *
 * A free string is safe here: it is only ever compared with `equals` against two columns, and the
 * link is sent to the address ON THE ACCOUNT, never to whatever was submitted.
 */
export class ForgotPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter the username or email address on your account.' })
  email: string;
}

/** Spend a reset link. The token is the credential; the email names the row it belongs to. */
export class ResetPasswordDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  password_confirmation: string;
}
