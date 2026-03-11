import { Injectable, Logger } from '@nestjs/common'
import { IngestCommentsDto } from './dto/ingest-comments.dto'

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name)

  async ingestBatch(tenantId: string, payload: IngestCommentsDto): Promise<void> {
    this.logger.log(
      `tenant=${tenantId} platform=${payload.platform} count=${payload.comments.length}`
    )
    // TODO: 写入 Redis Stream / Postgres，当前阶段先记录日志验证链路
  }
}
