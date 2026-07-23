import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class PostMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body: string;
}
