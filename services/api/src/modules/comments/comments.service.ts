import { Injectable, Logger } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { db, comments } from '../../db'
import { IngestCommentsDto } from './dto/ingest-comments.dto'

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name)

  async ingestBatch(tenantId: string, payload: IngestCommentsDto): Promise<{ saved: number; skipped: number }> {
    let saved = 0
    let skipped = 0

    for (const item of payload.comments) {
      const existing = await db
        .select({ id: comments.id })
        .from(comments)
        .where(
          and(
            eq(comments.tenantId, tenantId),
            eq(comments.platform, payload.platform),
            eq(comments.platformCommentId, item.platformCommentId),
          )
        )
        .limit(1)

      if (existing.length > 0) {
        skipped++
        continue
      }

      await db.insert(comments).values({
        tenantId,
        platform: payload.platform,
        platformCommentId: item.platformCommentId,
        authorName: item.authorName,
        content: item.content,
        postUrl: item.postUrl,
        commentedAt: new Date(item.commentedAt),
        status: 'pending',
      })
      saved++
    }

    this.logger.log(`tenant=${tenantId} platform=${payload.platform} saved=${saved} skipped=${skipped}`)
    return { saved, skipped }
  }

  async listByTenant(tenantId: string) {
    return db
      .select()
      .from(comments)
      .where(eq(comments.tenantId, tenantId))
      .orderBy(comments.commentedAt)
  }
}
