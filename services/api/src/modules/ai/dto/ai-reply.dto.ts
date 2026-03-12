import { IsOptional, IsString } from 'class-validator'

export class AiReplyDto {
  @IsString()
  commentId!: string

  @IsString()
  commentContent!: string

  @IsString()
  @IsOptional()
  persona?: string
}
