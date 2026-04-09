import React from "react"
import type { ReactNode } from "react"
import "./style.css"

interface LegalModalProps {
  title: string
  sections: { title: string; content: ReactNode }[]
  onClose: () => void
}

export function LegalModal({ title, sections, onClose }: LegalModalProps) {
  return (
    <div className="legal-modal-overlay" onClick={onClose}>
      <div className="legal-modal" onClick={e => e.stopPropagation()}>
        <div className="legal-modal-header">
          <h2 className="legal-modal-title">{title}</h2>
          <button type="button" className="legal-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="legal-modal-body">
          {sections.map((s, i) => (
            <section key={i} className="legal-section">
              <h3 className="legal-section-title">{s.title}</h3>
              <div className="legal-section-content">{s.content}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
