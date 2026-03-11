import { Body, Controller, Headers, Post } from '@nestjs/common'
import { CommentsService } from './comments.service'
import { IngestCommentsDto } from './dto/ingest-comments.dto'

@Controller('ingest/comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post()
  async ingest(
    @Headers('x-tenant-id') tenantId: string,
    @Body() body: IngestCommentsDto
  ) {
    // 简单多租户占位：后续可改为正式的认证守卫
    await this.commentsService.ingestBatch(tenantId, body)
    return { ok: true }
  }
}
