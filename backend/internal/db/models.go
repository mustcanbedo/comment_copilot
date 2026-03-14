package db

import (
	"time"
)

type User struct {
	ID           string    `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	Phone        string    `gorm:"column:phone;type:text;not null;uniqueIndex"`
	PasswordHash string    `gorm:"column:password_hash;type:text"`
	FullName     string    `gorm:"column:full_name;type:text;default:''"`
	CreatedAt    time.Time `gorm:"column:created_at;not null;default:CURRENT_TIMESTAMP"`
}

func (User) TableName() string { return "users" }
