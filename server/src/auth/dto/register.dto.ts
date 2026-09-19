import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsEmail()
  @MaxLength(255)
  email: string;

  // No minimum here: the one rule lives in `password-policy.ts` and `AuthService.register` asks it,
  // for the reasons set out on ChangePasswordDto.
  @IsString()
  password: string;

  // Laravel's `confirmed` rule — matched against `password` in the service.
  @IsString()
  password_confirmation: string;
}
