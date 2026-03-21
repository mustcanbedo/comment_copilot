/** Plasmo 打包会将 png 等静态资源解析为 URL 字符串 */
declare module "*.png" {
  const src: string
  export default src
}
