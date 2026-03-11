---
name: build-nestjs-api
description: 实现 Comment Copilot 后端 NestJS API，包含多租户守卫、模块结构、DTO 规范、事件总线发布。当实现后端 API 接口、创建 NestJS module/controller/service、处理评论入库、潜客管理等后端功能时使用。
---

# NestJS API 开发

## 模块结构（每个功能一个 module）

```
services/api/src/modules/
  comments/
    comments.controller.ts
    comments.service.ts
    comments.module.ts
    dto/ingest-comments.dto.ts
    entities/comment.entity.ts
  leads/
  ai/
  videos/
  notifications/
```

## 多租户守卫（每个接口必须）

```typescript
// 从 JWT 提取 tenantId，注入为参数装饰器
@Get()
@UseGuards(TenantGuard)
async findAll(@TenantId() tenantId: string, @Query() query: QueryDto) {
  return this.commentsService.findAll(tenantId, query);
}

// service 层强制过滤
async findAll(tenantId: string, query: QueryDto) {
  return this.repo.find({ where: { tenantId, ...query } });
}
```

## DTO 规范

```typescript
export class IngestCommentsDto {
  @IsUUID() videoId: string;
  @IsArray() @ValidateNested({ each: true })
  @Type(() => CommentItemDto)
  comments: CommentItemDto[];
}
```

## 评论入库后发事件

```typescript
// 写库成功后必须发布事件，触发 AI Pipeline
await this.eventBus.publish(new CommentIngestedEvent(comment.id, tenantId));
// 事件消费者：AI 服务订阅 comment.ingested → 意图识别 → 回复生成
```

## 关键接口列表

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/ingest/comments` | 插件上报评论（带 HMAC 签名校验） |
| GET | `/comments` | 查询评论列表（含分页、意图过滤） |
| PATCH | `/comments/:id/reply` | 审核并发送 AI 回复 |
| GET | `/leads` | 潜客看板 |
| PATCH | `/leads/:id/stage` | 更新潜客阶段 |
| POST | `/ai/reply` | 手动触发单条回复生成 |

## 错误处理

```typescript
// ✅ 结构化异常
throw new BadRequestException('comment_not_found');

// ❌ 禁止
throw new Error('not found');
throw 'error';
```
