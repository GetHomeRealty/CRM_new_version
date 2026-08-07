import { ArrayMaxSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { MentionService } from '../mention.service';

export class PostMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body: string;

  /**
   * User ids the author's autocomplete resolved as they typed.
   *
   * Validated here only for SHAPE. Whether each id may actually be mentioned — that the person
   * exists, is active, and can already open this deal — is decided by `MentionService`, on the
   * server, because these ids arrive from a client and a client can send anything.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MentionService.MAX_MENTIONS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  mentions?: number[];
}
