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
          <p>言灵 Yanling（以下简称「本产品」）是一款 Chrome 浏览器扩展，结合后端服务，为小红书等平台用户提供评论相关的 AI 文案建议（含回复他人评论、在笔记下发表跟评等场景）。本产品采用「用户数字助理」模式：</p>
          <ul>
            <li>仅读取页面上用户可见的公开内容（如评论、笔记展示区域，以 DOM 解析方式）</li>
            <li>可将 AI 文案<strong>一键填入</strong>平台评论或回复输入框；<strong>不自动发送</strong>，发送须由您在平台内手动点击完成</li>
            <li>不模拟登录、不调用平台官方未开放接口代发内容、不进行违背平台规则的批量自动化操作</li>
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
          <p>本产品为 Chrome 扩展，需访问小红书、抖音等页面以提供评论相关 AI 文案建议（含回复、笔记跟评等场景）。我们可能收集以下信息：</p>
          <ul>
            <li><strong>账户信息：</strong>邮箱、昵称（用于注册与登录；昵称为选填）</li>
            <li><strong>页面数据：</strong>当您浏览小红书/抖音笔记页时，扩展会读取您可见的评论内容、评论者昵称、帖子链接及笔记展示区域中与生成回复相关的可见文本，仅用于提供 AI 建议与同步侧栏列表，不用于其他目的</li>
            <li><strong>本地补充信息（可选）：</strong>若您在「灵主」填写小红书昵称，该信息仅保存在本机浏览器扩展存储中，用于在采集评论时区分您本人与其他用户，不会作为账号必填信息上传用于画像</li>
            <li><strong>技术数据：</strong>设备类型、浏览器版本（用于兼容性保障）</li>
          </ul>
          <p>扩展使用的权限说明：storage（保存登录状态、设置与上述本地补充项）、activeTab/tabs（识别当前浏览页面）、host_permissions（访问小红书、抖音及后端 API）。</p>
        </>
      ),
    },
    {
      title: "二、信息使用",
      content: (
        <p>我们使用上述信息仅用于：提供 AI 文案建议与侧栏功能、管理账户、改进产品体验及保障服务安全。我们不会将您的个人信息出售给第三方。</p>
      ),
    },
    {
      title: "三、数据存储与安全",
      content: (
        <p>您的数据存储在安全的服务器上，我们采用加密传输（HTTPS）和访问控制措施保护您的信息。为生成 AI 建议而组装的可见页面文本（如评论、帖子上下文）会发送至第三方 AI 服务商 DeepSeek（<ExternalLink href="https://www.deepseek.com">deepseek.com</ExternalLink>），仅用于当次生成，不用于我们侧的长期画像；是否用于训练以 DeepSeek 政策为准。建议您查阅其隐私政策。</p>
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
        <p>账户信息在您使用期间持续保留，直至您注销账户。页面内容在 AI 处理流程中按需传送至服务商，处理完成后服务端不长期存储原文用于训练（以服务商政策为准）。本地存储（登录状态、设置、可选的小红书昵称补充）保留在您的设备上，卸载扩展或退出登录按产品逻辑清除相应项。</p>
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
