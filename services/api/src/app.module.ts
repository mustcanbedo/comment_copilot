import { Module } from '@nestjs/common'
import { CommentsModule } from './modules/comments/comments.module'

@Module({
  imports: [CommentsModule],
})
export class AppModule {}
