package repository

import (
	"comment-copilot-web-backend/internal/db"

	"gorm.io/gorm"
)

type SavedReplyRepository struct {
	db *gorm.DB
}

func NewSavedReplyRepository(gdb *gorm.DB) *SavedReplyRepository {
	return &SavedReplyRepository{db: gdb}
}

func (r *SavedReplyRepository) List(userID, tenantID, category, search string, limit int) ([]db.SavedReply, error) {
	q := r.db.Where("user_id = ?", userID)
	if tenantID != "" {
		q = q.Where("tenant_id = ?", tenantID)
	}
	if category != "" && category != "全部" {
		q = q.Where("category = ?", category)
	}
	if search != "" {
		q = q.Where("text ILIKE ? OR from_comment_snippet ILIKE ?", "%"+search+"%", "%"+search+"%")
	}
	var list []db.SavedReply
	err := q.Order("created_at DESC").Limit(limit).Find(&list).Error
	return list, err
}

func (r *SavedReplyRepository) Create(sr *db.SavedReply) error {
	return r.db.Create(sr).Error
}

func (r *SavedReplyRepository) DeleteByIDAndUser(id, userID string) error {
	return r.db.Where("id = ? AND user_id = ?", id, userID).Delete(&db.SavedReply{}).Error
}

func (r *SavedReplyRepository) DeleteByIDAndUserAndTenant(id, userID, tenantID string) error {
	return r.db.Where("id = ? AND user_id = ? AND tenant_id = ?", id, userID, tenantID).Delete(&db.SavedReply{}).Error
}

func (r *SavedReplyRepository) FindByTextAndFromComment(userID, text, fromSnippet string) (*db.SavedReply, error) {
	var sr db.SavedReply
	err := r.db.Where("user_id = ? AND text = ? AND from_comment_snippet = ?", userID, text, fromSnippet).
		First(&sr).Error
	if err != nil {
		return nil, err
	}
	return &sr, nil
}
