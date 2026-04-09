package repository

import (
	"errors"

	"comment-copilot-web-backend/internal/db"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrInsufficientPoints = errors.New("insufficient_points")

// DeductResult 记录扣费来源，用于失败回退
type DeductResult struct {
	FromFree int64
	FromTopup int64
}

type UserRepository struct {
	db *gorm.DB
}

func NewUserRepository(gdb *gorm.DB) *UserRepository {
	return &UserRepository{db: gdb}
}

// DeductPoints 扣减积分，优先扣免费积分。使用事务 + 行锁保证并发安全。
// 返回扣费明细，用于 AI 失败时回退。
func (r *UserRepository) DeductPoints(userID string, amount int64) (*DeductResult, error) {
	if amount <= 0 {
		return nil, errors.New("amount must be positive")
	}

	var result DeductResult
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var user db.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", userID).First(&user).Error; err != nil {
			return err
		}

		total := user.FreePointsBalance + user.TopupPointsBalance
		if total < amount {
			return ErrInsufficientPoints
		}

		if user.FreePointsBalance >= amount {
			result.FromFree = amount
			user.FreePointsBalance -= amount
		} else {
			result.FromFree = user.FreePointsBalance
			result.FromTopup = amount - user.FreePointsBalance
			user.FreePointsBalance = 0
			user.TopupPointsBalance -= result.FromTopup
		}

		return tx.Save(&user).Error
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// RefundPoints 回退积分，用于 AI 调用失败时恢复
func (r *UserRepository) RefundPoints(userID string, fromFree, fromTopup int64) error {
	if fromFree <= 0 && fromTopup <= 0 {
		return nil
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		var user db.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", userID).First(&user).Error; err != nil {
			return err
		}
		user.FreePointsBalance += fromFree
		user.TopupPointsBalance += fromTopup
		return tx.Save(&user).Error
	})
}
