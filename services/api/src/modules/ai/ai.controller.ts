import { Body, Controller, Headers, Post } from '@nestjs/common'
import { AiService } from './ai.service'
import { AiReplyDto } from './dto/ai-reply.dto'

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('reply')
  async reply(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: AiReplyDto,
  ) {
    const result = await this.aiService.generateReply(tenantId, dto)
    return { ok: true, ...result }
  }
}
