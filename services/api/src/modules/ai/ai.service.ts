import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { db, aiReplies, comments } from '../../db'
import { AiReplyDto } from './dto/ai-reply.dto'

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions'

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name)

  async generateReply(tenantId: string, dto: AiReplyDto): Promise<{ suggestions: string[] }> {
    const persona = dto.persona ?? '热情友好的品牌客服'

    const systemPrompt = `你是一个${persona}，负责回复小红书/抖音等平台的用户评论。
要求：
1. 回复简短自然，15-40字为宜
2. 语气亲切，符合中文社交媒体风格
3. 不要使用"您"，用"你"更自然
4. 不要回复与产品无关的内容
5. 输出 JSON 格式：{"suggestions": ["回复1", "回复2", "回复3"]}`

    const userPrompt = `用户评论：${dto.commentContent}\n\n请生成3条候选回复。`

    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) {
      throw new InternalServerErrorException('DEEPSEEK_API_KEY not configured')
    }

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 300,
        temperature: 0.8,
        response_format: { type: 'json_object' },
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      this.logger.error(`DeepSeek API error: ${err}`)
      throw new InternalServerErrorException('AI service error')
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[]
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    const content = data.choices[0].message.content
    const parsed = JSON.parse(content) as { suggestions: string[] }

    await db.insert(aiReplies).values({
      tenantId,
      commentId: dto.commentId,
      suggestions: parsed.suggestions,
      modelUsed: 'deepseek-chat',
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
    })

    await db
      .update(comments)
      .set({ status: 'replied' })
      .where(eq(comments.id, dto.commentId))

    this.logger.log(`tenant=${tenantId} commentId=${dto.commentId} tokens=${data.usage.prompt_tokens}+${data.usage.completion_tokens}`)

    return { suggestions: parsed.suggestions }
  }
}
