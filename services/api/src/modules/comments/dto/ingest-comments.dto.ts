import { Type } from 'class-transformer'
import { IsArray, IsISO8601, IsOptional, IsString, ValidateNested } from 'class-validator'

export class CommentItemDto {
  @IsString()
  platformCommentId!: string

  @IsString()
  authorName!: string

  @IsString()
  content!: string

  @IsISO8601()
  commentedAt!: string
}

export class IngestCommentsDto {
  @IsString()
  platform!: 'xiaohongshu' | 'douyin' | 'kuaishou'

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CommentItemDto)
  comments!: CommentItemDto[]
}
