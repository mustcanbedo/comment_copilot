import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { Controller, Get } from '@nestjs/common'
import { AiModule } from './modules/ai/ai.module'
import { CommentsModule } from './modules/comments/comments.module'

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { status: 'ok', ts: new Date().toISOString() }
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommentsModule,
    AiModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
