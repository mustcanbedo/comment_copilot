package db

import (
	"time"
)

// DefaultTenantID 注册用户时的默认租户（与扩展端 DEFAULT_TENANT_ID 一致）
const DefaultTenantID = "00000000-0000-0000-0000-000000000001"

type User struct {
	ID           string    `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	TenantID     string    `gorm:"column:tenant_id;type:uuid;not null;default:00000000-0000-0000-0000-000000000001"`
	Email        string    `gorm:"column:email;type:text;not null;uniqueIndex"`
	Phone        string    `gorm:"column:phone;type:text;not null;default:''"` // 兼容旧表 NOT NULL，邮箱注册时填 email 或空串
	PasswordHash string    `gorm:"column:password_hash;type:text"`
	FullName     string    `gorm:"column:full_name;type:text;default:''"`
	CreatedAt    time.Time `gorm:"column:created_at;not null;default:CURRENT_TIMESTAMP"`
}

func (User) TableName() string { return "users" }
