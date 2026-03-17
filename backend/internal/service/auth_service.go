package service

import (
	"errors"
	"time"

	"comment-copilot-web-backend/internal/db"
	"comment-copilot-web-backend/internal/middleware"
	"comment-copilot-web-backend/internal/repository"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

var (
	ErrEmailExists        = errors.New("email already registered")
	ErrInvalidCredentials = errors.New("invalid credentials")
)

type AuthService struct {
	repo *repository.AuthRepository
}

func NewAuthService(repo *repository.AuthRepository) *AuthService {
	return &AuthService{repo: repo}
}

func (s *AuthService) Register(email, password, name string) (*db.User, error) {
	exists, err := s.repo.CountUserByEmail(email)
	if err != nil {
		return nil, err
	}
	if exists > 0 {
		return nil, ErrEmailExists
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	user := &db.User{
		TenantID:     db.DefaultTenantID,
		Email:        email,
		Phone:        email, // 兼容表内 phone NOT NULL，用 email 占位
		PasswordHash: string(hash),
		FullName:     name,
	}
	if err := s.repo.CreateUser(user); err != nil {
		return nil, err
	}

	return user, nil
}

func (s *AuthService) Login(email, password, secret string) (*db.User, string, error) {
	user, err := s.repo.FindUserByEmail(email)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, "", ErrInvalidCredentials
		}
		return nil, "", err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, "", ErrInvalidCredentials
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, middleware.Claims{
		UserID: user.ID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(7 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	})
	signed, err := token.SignedString([]byte(secret))
	if err != nil {
		return nil, "", err
	}
	return user, signed, nil
}

func (s *AuthService) Me(userID string) (*db.User, error) {
	return s.repo.FindUserByID(userID)
}
