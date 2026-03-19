import { useState } from "react"
import { API_BASE } from "../constants"
import { LegalModal } from "./legal-modal"
import { TERMS_OF_SERVICE, PRIVACY_POLICY } from "./legal-content"
import "./style.css"

const AUTH_TOKEN_KEY = "authToken"

interface LoginViewProps {
  onSuccess: (token: string) => void
  apiBase?: string
}

function LogoIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7 9h10M7 13h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function GoogleGIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.8 10.23c0-.68-.06-1.34-.16-1.98H10v3.74h5.5a4.45 4.45 0 0 1-1.93 2.92v2.43h3.12c1.83-1.68 2.88-4.16 2.88-7.11z" fill="#4285F4"/>
      <path d="M10 20c2.7 0 4.96-.9 6.62-2.45l-3.12-2.43c-.9.6-2.04.95-3.5.95-2.7 0-4.99-1.82-5.82-4.27H.94v2.5A9.99 9.99 0 0 0 10 20z" fill="#34A853"/>
      <path d="M4.18 12.52A5.99 5.99 0 0 1 3.82 10c0-.66.12-1.3.36-1.9V5.6H1.18A9.99 9.99 0 0 0 0 10c0 1.62.39 3.14 1.08 4.48l3.1-2.36z" fill="#FBBC05"/>
      <path d="M10 3.98c1.52 0 2.88.52 3.96 1.54l2.96-2.96C14.96.99 12.7 0 10 0 5.96 0 2.18 2.22.94 5.6l3.24 2.52C6 5.77 7.7 3.98 10 3.98z" fill="#EA4335"/>
    </svg>
  )
}

export default function LoginView({ onSuccess, apiBase = API_BASE.replace("/api", "") }: LoginViewProps) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [showRegister, setShowRegister] = useState(false)
  const [legalModal, setLegalModal] = useState<"terms" | "privacy" | null>(null)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "邮箱或密码错误")
      } else {
        const token = data.token ?? ""
        if (token) {
          const { Storage } = await import("@plasmohq/storage")
          const storage = new Storage()
          await storage.set(AUTH_TOKEN_KEY, token)
          onSuccess(token)
        }
      }
    } catch {
      setError("网络错误，请稍后重试")
    } finally {
      setLoading(false)
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`${apiBase}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name: name || undefined }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 409) {
          setError(data.error || "该邮箱已注册")
        } else {
          setError(data.detail || data.error || "注册失败")
        }
      } else {
        // 注册成功：跳回登录页，邮箱和密码已保留在 state 中，登录表单会自动带出
        setError("")
        setShowRegister(false)
      }
    } catch {
      setError("网络错误，请稍后重试")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-inner">
        <div className="login-logo-wrap">
          <div className="login-logo">
            <LogoIcon size={44} />
          </div>
        </div>
        <h1 className="login-title">Comment Copilot</h1>
        <p className="login-subtitle">用 AI 回复评论，把路人变成客户</p>

        {!showRegister ? (
          <>
            <button type="button" className="login-google-btn" disabled>
              <GoogleGIcon />
              <span>使用 Google 账号登录</span>
            </button>

            <div className="login-divider">
              <span>或使用邮箱登录</span>
            </div>

            <form onSubmit={handleLogin} className="login-form">
              <input
                type="email"
                className="login-input"
                placeholder="your@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
              <div className="login-password-row">
                <input
                  type="password"
                  className="login-input"
                  placeholder="密码"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                />
                <button type="button" className="login-forgot">忘记密码？</button>
              </div>
              {error && <p className="login-error">{error}</p>}
              <button type="submit" className="login-btn" disabled={loading}>
                {loading ? "登录中…" : "登录"}
              </button>
            </form>

            <div className="login-footer">
              <p>
                还没有账号？{" "}
                <button type="button" className="login-link" onClick={() => { setShowRegister(true); setError("") }}>
                  免费注册
                </button>
              </p>
              <p className="login-terms">
                登录即表示同意{" "}
                <button type="button" className="login-link" onClick={() => setLegalModal("terms")}>服务条款</button> 和{" "}
                <button type="button" className="login-link" onClick={() => setLegalModal("privacy")}>隐私政策</button>
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="login-divider">
              <span>邮箱注册</span>
            </div>

            <form onSubmit={handleRegister} className="login-form">
              <input
                type="email"
                className="login-input"
                placeholder="your@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
              <input
                type="text"
                className="login-input"
                placeholder="昵称（选填）"
                value={name}
                onChange={e => setName(e.target.value)}
              />
              <input
                type="password"
                className="login-input"
                placeholder="密码（至少 8 位）"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
              />
              {error && <p className="login-error">{error}</p>}
              <button type="submit" className="login-btn" disabled={loading}>
                {loading ? "注册中…" : "注册"}
              </button>
            </form>

            <div className="login-footer">
              <p>
                已有账号？{" "}
                <button type="button" className="login-link" onClick={() => { setShowRegister(false); setError("") }}>
                  直接登录
                </button>
              </p>
              <p className="login-terms">
                注册即表示同意{" "}
                <button type="button" className="login-link" onClick={() => setLegalModal("terms")}>服务条款</button> 和{" "}
                <button type="button" className="login-link" onClick={() => setLegalModal("privacy")}>隐私政策</button>
              </p>
            </div>
          </>
        )}

        {legalModal === "terms" && (
          <LegalModal
            title={TERMS_OF_SERVICE.title}
            sections={TERMS_OF_SERVICE.sections}
            onClose={() => setLegalModal(null)}
          />
        )}
        {legalModal === "privacy" && (
          <LegalModal
            title={PRIVACY_POLICY.title}
            sections={PRIVACY_POLICY.sections}
            onClose={() => setLegalModal(null)}
          />
        )}
      </div>
    </div>
  )
}

export { AUTH_TOKEN_KEY }
