package db

import (
	"time"
)

// DefaultTenantID 注册用户时的默认租户（与扩展端 DEFAULT_TENANT_ID 一致）
const DefaultTenantID = "00000000-0000-0000-0000-000000000001"

// FreePointsQuota 注册赠送的免费积分额度（1 积分 = 1 次 AI 调用）
const FreePointsQuota = 2000

type User struct {
	ID                 string    `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	TenantID           string    `gorm:"column:tenant_id;type:uuid;not null;default:00000000-0000-0000-0000-000000000001"`
	Email              string    `gorm:"column:email;type:text;not null;uniqueIndex"`
	Phone              string    `gorm:"column:phone;type:text;not null;default:''"` // 兼容旧表 NOT NULL，邮箱注册时填 email 或空串
	PasswordHash       string    `gorm:"column:password_hash;type:text"`
	FullName           string    `gorm:"column:full_name;type:text;default:''"`
	FreePointsBalance  int64     `gorm:"column:free_points_balance;not null;default:2000"`  // 免费积分剩余
	TopupPointsBalance int64     `gorm:"column:topup_points_balance;not null;default:0"`    // 充值积分余额
	CreatedAt          time.Time `gorm:"column:created_at;not null;default:CURRENT_TIMESTAMP"`
}

func (User) TableName() string { return "users" }

type Comment struct {
	ID                string     `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	TenantID          string     `gorm:"column:tenant_id;type:uuid;not null;index"`
	Platform          string     `gorm:"column:platform;type:text;not null"`
	PlatformCommentID string     `gorm:"column:platform_comment_id;type:text;not null"`
	AuthorName        string     `gorm:"column:author_name;type:text;not null"`
	Content           string     `gorm:"column:content;type:text;not null"`
	IntentLevel       string     `gorm:"column:intent_level;type:text;default:cold"`
	Status            string     `gorm:"column:status;type:text;not null;default:pending"`
	CommentedAt       time.Time  `gorm:"column:commented_at;not null"`
	PostURL           string     `gorm:"column:post_url;type:text"`
	IsAuthorReply     bool       `gorm:"column:is_author_reply;default:false"`
	RepliedAt         *time.Time `gorm:"column:replied_at"`
	CreatedAt         time.Time  `gorm:"column:created_at;not null;default:CURRENT_TIMESTAMP"`
}

func (Comment) TableName() string { return "comments" }

type SavedReply struct {
	ID                 string    `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID             string    `gorm:"column:user_id;type:uuid;not null;index"`
	TenantID           string    `gorm:"column:tenant_id;type:uuid;not null;index"`
	Text               string    `gorm:"column:text;type:text;not null"`
	FromCommentID      string    `gorm:"column:from_comment_id;type:text"`
	FromCommentSnippet string    `gorm:"column:from_comment_snippet;type:text"`
	Category           string    `gorm:"column:category;type:text;not null;default:默认"`
	CreatedAt          time.Time `gorm:"column:created_at;not null;default:CURRENT_TIMESTAMP"`
	UpdatedAt          time.Time `gorm:"column:updated_at;not null;default:CURRENT_TIMESTAMP"`
}

func (SavedReply) TableName() string { return "saved_replies" }
