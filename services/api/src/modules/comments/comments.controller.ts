import { Body, Controller, Get, Headers, Post } from '@nestjs/common'
import { CommentsService } from './comments.service'
import { IngestCommentsDto } from './dto/ingest-comments.dto'

@Controller()
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post('ingest/comments')
  async ingest(
    @Headers('x-tenant-id') tenantId: string,
    @Body() body: IngestCommentsDto,
  ) {
    const result = await this.commentsService.ingestBatch(tenantId, body)
    return { ok: true, ...result }
  }

  @Get('comments')
  async list(@Headers('x-tenant-id') tenantId: string) {
    const data = await this.commentsService.listByTenant(tenantId)
    return { ok: true, data }
  }
}
