import { Equals, IsNotEmpty, IsString, IsUrl, Length, Matches, MaxLength } from 'class-validator';

const PKCE = /^[A-Za-z0-9._~-]+$/;

export class SsoAuthorizeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  client_id!: string;

  @IsUrl({ require_protocol: true, require_tld: false }, { message: 'redirect_uri must be an absolute URL.' })
  @MaxLength(2048)
  redirect_uri!: string;

  @IsString()
  @Length(43, 128)
  @Matches(PKCE)
  code_challenge!: string;

  @Equals('S256')
  code_challenge_method!: 'S256';

  @IsString()
  @Length(16, 256)
  state!: string;
}

export class SsoTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  client_id!: string;

  @IsString()
  @Length(32, 512)
  client_secret!: string;

  @IsUrl({ require_protocol: true, require_tld: false }, { message: 'redirect_uri must be an absolute URL.' })
  @MaxLength(2048)
  redirect_uri!: string;

  @IsString()
  @Length(43, 128)
  code!: string;

  @IsString()
  @Length(43, 128)
  @Matches(PKCE)
  code_verifier!: string;
}
