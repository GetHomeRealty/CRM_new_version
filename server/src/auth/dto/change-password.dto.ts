import { IsNotEmpty, IsString } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  current_password: string;

  /*
   * NO `@MinLength` HERE, DELIBERATELY. The length is part of the strength rule in
   * `password-policy.ts`, which `AuthService.changePassword` asks. A minimum declared here as well
   * would be a second rule that has to be kept in step with the first — which is exactly how this
   * application came to have three different copies of "at least eight characters", one of which
   * was missing. It also runs first and would answer with the framework's own wording instead of
   * the sentence the other password screens give.
   */
  @IsString()
  password: string;

  // Laravel's `confirmed` rule — matched against `password` in the service.
  @IsString()
  password_confirmation: string;
}
