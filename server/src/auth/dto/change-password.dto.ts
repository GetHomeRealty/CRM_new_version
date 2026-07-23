import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  current_password: string;

  @IsString()
  @MinLength(8)
  password: string;

  // Laravel's `confirmed` rule — matched against `password` in the service.
  @IsString()
  password_confirmation: string;
}
