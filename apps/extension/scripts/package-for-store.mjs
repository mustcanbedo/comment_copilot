#!/usr/bin/env node
/**
 * 临时从 package.json 的 host_permissions 中移除 localhost，再执行 build + package，
 * 最后恢复原文件。用于 Chrome 网上应用店上传（商店包不得含开发用 localhost）。
 * @see ../../docs/chrome-web-store-supplements.md
 */
import { readFileSync, writeFileSync } from "fs"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkgPath = join(root, "package.json")
const original = readFileSync(pkgPath, "utf8")
const pkg = JSON.parse(original)

const filtered = (pkg.manifest?.host_permissions ?? []).filter(
  (h) => !String(h).toLowerCase().includes("localhost")
)

if (filtered.length === pkg.manifest.host_permissions.length) {
  console.warn(
    "[package-for-store] 未找到含 localhost 的 host_permissions，将直接构建（请确认已按需配置）"
  )
}

function restore() {
  writeFileSync(pkgPath, original)
}

process.on("SIGINT", () => {
  restore()
  process.exit(130)
})

let exitCode = 1
try {
  pkg.manifest.host_permissions = filtered
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")

  const run = (args) => {
    const r = spawnSync("npm", args, { cwd: root, stdio: "inherit", shell: true })
    return r.status ?? 1
  }

  exitCode = run(["run", "build"])
  if (exitCode !== 0) {
    // 勿在 restore 前 process.exit，否则 finally 不执行
    process.exitCode = exitCode
  } else {
    exitCode = run(["run", "package"])
    process.exitCode = exitCode
  }
} finally {
  restore()
}

process.exit()
