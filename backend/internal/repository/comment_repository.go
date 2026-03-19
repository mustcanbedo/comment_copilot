package repository

import (
	"comment-copilot-web-backend/internal/db"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type CommentRepository struct {
	db *gorm.DB
}

func NewCommentRepository(gdb *gorm.DB) *CommentRepository {
	return &CommentRepository{db: gdb}
}

func (r *CommentRepository) UpsertFromIngest(tenantID, platform string, items []IngestItem) (saved, skipped int, err error) {
	if len(items) == 0 {
		return 0, 0, nil
	}

	// 批量查询已存在的 platform_comment_id
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = items[i].PlatformCommentID
	}

	var existingIDs []string
	if err := r.db.Model(&db.Comment{}).
		Where("tenant_id = ? AND platform = ? AND platform_comment_id IN ?", tenantID, platform, ids).
		Pluck("platform_comment_id", &existingIDs).Error; err != nil {
		return 0, 0, err
	}

	existed := make(map[string]bool)
	for _, id := range existingIDs {
		existed[id] = true
	}

	// 批量插入新评论，ON CONFLICT DO NOTHING 防止并发重复
	var toInsert []db.Comment
	for _, item := range items {
		if existed[item.PlatformCommentID] {
			skipped++
			continue
		}

		commentedAt, _ := time.Parse(time.RFC3339, item.CommentedAt)
		if item.CommentedAt == "" {
			commentedAt = time.Now()
		}

		status := "pending"
		if item.IsAuthorReply {
			status = "author"
		}

		toInsert = append(toInsert, db.Comment{
			TenantID:          tenantID,
			Platform:          platform,
			PlatformCommentID: item.PlatformCommentID,
			AuthorName:        item.AuthorName,
			Content:           item.Content,
			IntentLevel:       "cold",
			Status:            status,
			CommentedAt:       commentedAt,
			PostURL:           item.PostURL,
			IsAuthorReply:     item.IsAuthorReply,
		})
	}

	if len(toInsert) == 0 {
		return 0, skipped, nil
	}

	// 使用 ON CONFLICT DO NOTHING，并发 ingest 时重复记录会被忽略
	result := r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "tenant_id"},
			{Name: "platform"},
			{Name: "platform_comment_id"},
		},
		DoNothing: true,
	}).CreateInBatches(toInsert, 50)
	if result.Error != nil {
		return 0, skipped, result.Error
	}
	saved = int(result.RowsAffected)
	return saved, skipped, nil
}

type IngestItem struct {
	PlatformCommentID string `json:"platformCommentId"`
	AuthorName        string `json:"authorName"`
	Content           string `json:"content"`
	CommentedAt      string `json:"commentedAt"`
	PostURL           string `json:"postUrl"`
	IsAuthorReply     bool   `json:"isAuthorReply"`
}

func (r *CommentRepository) List(tenantID, postURL, intent, status string, limit int) ([]db.Comment, error) {
	q := r.db.Where("tenant_id = ? AND is_author_reply = ?", tenantID, false)
	if postURL != "" {
		q = q.Where("post_url = ?", postURL)
	}
	if intent != "" {
		q = q.Where("intent_level = ?", intent)
	}
	if status != "" {
		q = q.Where("status = ?", status)
	}
	var list []db.Comment
	err := q.Order("commented_at DESC").Limit(limit).Find(&list).Error
	return list, err
}

func (r *CommentRepository) MarkReplied(tenantID, platform, platformCommentID string) error {
	now := time.Now()
	return r.db.Model(&db.Comment{}).
		Where("tenant_id = ? AND platform = ? AND platform_comment_id = ?", tenantID, platform, platformCommentID).
		Updates(map[string]interface{}{"status": "replied", "replied_at": now}).Error
}
