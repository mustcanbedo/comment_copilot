package repository

import (
	"comment-copilot-web-backend/internal/db"

	"gorm.io/gorm"
)

type AuthRepository struct {
	db *gorm.DB
}

func NewAuthRepository(gdb *gorm.DB) *AuthRepository {
	return &AuthRepository{db: gdb}
}

func (r *AuthRepository) CountUserByEmail(email string) (int64, error) {
	var exists int64
	err := r.db.Model(&db.User{}).Where("email = ?", email).Count(&exists).Error
	return exists, err
}

func (r *AuthRepository) CreateUser(u *db.User) error {
	return r.db.Create(u).Error
}

func (r *AuthRepository) FindUserByEmail(email string) (*db.User, error) {
	var user db.User
	if err := r.db.Where("email = ?", email).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

func (r *AuthRepository) FindUserByID(userID string) (*db.User, error) {
	var user db.User
	if err := r.db.Where("id = ?", userID).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}
