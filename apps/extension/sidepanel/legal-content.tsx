import type { ReactNode } from "react"
import { FEEDBACK_EMAIL } from "../constants"

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => {
        e.preventDefault()
        if (typeof chrome !== "undefined" && chrome.tabs) {
          chrome.tabs.create({ url: href })
        } else {
          window.open(href, "_blank")
        }
      }}
    >
      {children}
    </a>
  )
}

export const TERMS_OF_SERVICE: { title: string; sections: { title: string; content: ReactNode }[] } = {
  title: "言灵 Yanling 服务条款",
  sections: [
    {
      title: "一、服务说明",
      content: (
        <>
          <p>言灵 Yanling（以下简称「本产品」）是一款 Chrome 浏览器扩展，结合后端服务，为小红书等平台的创作者提供评论 AI 回复建议。本产品采用「用户数字助理」模式：</p>
          <ul>
            <li>仅读取页面上用户可见的公开评论（DOM 解析）</li>
            <li>不自动发送任何内容，发送由用户手动确认</li>
            <li>不模拟登录、不调用平台 API、不批量操作</li>
          </ul>
        </>
      ),
    },
    {
      title: "二、用户义务",
      content: (
        <>
          <p>使用本产品时，您同意：</p>
          <ul>
            <li>遵守小红书平台规则及法律法规</li>
            <li>不利用本产品进行任何违规、欺诈或违法活动</li>
            <li>不将本产品用于批量爬取、骚扰或滥用</li>
          </ul>
        </>
      ),
    },
    {
      title: "三、服务变更与终止",
      content: (
        <>
          <p>我们保留随时修改、暂停或终止本产品或其部分功能的权利。重大变更将提前通知用户。</p>
          <p>若您违反本条款、平台规则或法律法规，我们有权暂停或终止您的账户，且不予退还已付费金额（如有）。</p>
        </>
      ),
    },
    {
      title: "四、免责声明",
      content: (
        <p>本产品提供的 AI 回复仅供参考，用户需自行判断并承担使用后果。我们不对因使用本产品产生的任何直接或间接损失负责。</p>
      ),
    },
    {
      title: "五、联系方式",
      content: (
        <p>如有疑问，请通过产品内「驭灵」→「关于」→「意见反馈」或发送邮件至 {FEEDBACK_EMAIL} 联系我们。</p>
      ),
    },
  ],
}

export const PRIVACY_POLICY: { title: string; sections: { title: string; content: ReactNode }[] } = {
  title: "言灵 Yanling 隐私政策",
  sections: [
    {
      title: "一、收集的信息",
      content: (
        <>
          <p>本产品为 Chrome 扩展，需访问小红书、抖音等页面以提供 AI 回复功能。我们可能收集以下信息：</p>
          <ul>
            <li><strong>账户信息：</strong>邮箱、昵称（用于注册与登录）</li>
            <li><strong>页面数据：</strong>当您浏览小红书/抖音笔记页时，扩展会读取您可见的评论内容、评论者昵称及帖子链接，仅用于生成 AI 回复，不用于其他目的</li>
            <li><strong>技术数据：</strong>设备类型、浏览器版本（用于兼容性保障）</li>
          </ul>
          <p>扩展使用的权限说明：storage（保存登录状态与设置）、activeTab/tabs（识别当前浏览页面）、host_permissions（访问小红书、抖音及后端 API）。</p>
        </>
      ),
    },
    {
      title: "二、信息使用",
      content: (
        <p>我们使用上述信息仅用于：提供 AI 回复服务、管理账户、改进产品体验及保障服务安全。我们不会将您的个人信息出售给第三方。</p>
      ),
    },
    {
      title: "三、数据存储与安全",
      content: (
        <p>您的数据存储在安全的服务器上，我们采用加密传输（HTTPS）和访问控制措施保护您的信息。评论内容在 AI 处理过程中会发送至第三方 AI 服务商 DeepSeek（<ExternalLink href="https://www.deepseek.com">deepseek.com</ExternalLink>），仅用于生成回复，不用于训练或长期存储。建议您查阅 DeepSeek 的隐私政策以了解其数据处理方式。</p>
      ),
    },
    {
      title: "四、Cookie 与本地存储",
      content: (
        <p>本产品使用 Chrome 扩展的本地存储功能保存登录状态、设置等，以提升您的使用体验。这些数据仅保存在您的设备上。</p>
      ),
    },
    {
      title: "五、数据保留",
      content: (
        <p>账户信息在您使用期间持续保留，直至您注销账户。评论内容在 AI 处理完成后不长期存储。本地存储（登录状态、设置）保留在您的设备上，卸载扩展即可清除。</p>
      ),
    },
    {
      title: "六、您的权利",
      content: (
        <p>您有权注销账户、请求删除个人数据或索取数据副本。请通过产品内「驭灵」→「关于」→「意见反馈」或发送邮件至 {FEEDBACK_EMAIL} 提交申请，我们将在合理期限内处理。</p>
      ),
    },
    {
      title: "七、政策更新",
      content: (
        <p>我们可能适时更新本隐私政策。重大变更将通过产品内通知或邮件告知您。</p>
      ),
    },
  ],
}
