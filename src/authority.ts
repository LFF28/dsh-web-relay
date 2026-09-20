/**
 * 权威的规范化与形状校验。
 *
 * DSH 的 `/api` 围栏把「请求的 Host 是不是我们自己的」当作第一道判定，浏览器
 * Cookie 的名字与签名负载也都绑定权威。插件在这里做的只有一件事：把部署里填的
 * `vps.host` 与 `gateway.port` 归到同一个规范形式，并挡掉会被 WHATWG 解析悄悄
 * 改写的写法——那种输入会把「只授权某个端口」放大成「授权这个主机的任意端口」。
 *
 * 规则逐条复刻自 `@deepseek-ai/dsh-client-connection` 的 `api-request-trust.ts`。
 * 那个包没有导出 `assertTrustedAuthority`，所以这里必须自己实现；与它不一致的
 * 表现是「手机打不开」，是所有故障里最难归因的一类。
 * @module dsh-web-relay/authority
 */

/**
 * 按 WHATWG 规则解析一个权威，解析不出来时返回 undefined。
 * @param authority - `host` 或 `host:port` 形式的裸权威。
 * @returns 解析结果；`http:` 是 special scheme，成功时 hostname 必然非空。
 */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * 从已解析的权威取显式端口。
 *
 * 只看 `http:` 的解析结果会漏掉一件事：两个 special scheme 的默认端口不同，
 * 所以 `:80` 与 `:443` 在另一个 scheme 下才算显式。两个都问一遍，才能让
 * `host:443` 保持带端口的形式，而不是被当成默认值抹掉。
 * @param entry - 原始输入。
 * @param url - `http:` 下的解析结果。
 * @returns 端口字符串，未写出时为 `''`。
 */
function explicitPort(entry: string, url: URL): string {
  return url.port !== '' ? url.port : new URL(`https://${entry}`).port
}

/**
 * 权威的规范形式：没写端口时是 `hostname`，写了就是 `hostname:port`。
 * IPv6 的方括号由 WHATWG 保留，因此这里的冒号判断不会把它误当成端口分隔符。
 * @param authority - 裸权威。
 * @returns 规范形式，解析失败时为 undefined。
 */
export function canonicalAuthority(authority: string): string | undefined {
  const url = parseAuthority(authority)
  if (url === undefined) return undefined
  const port = explicitPort(authority, url)
  return port === '' ? url.hostname : `${url.hostname}:${port}`
}

/**
 * 判断一个输入是不是**裸的规范权威**。
 *
 * 解析会悄悄改写的写法一律判为非法，因为它们要么是笔误、要么在偷偷扩大授权：
 * 带 path 或 userinfo（`harness.internal/path`、`user@harness.internal`，后者会
 * 授权内嵌的那个主机名）、首尾空白、悬空冒号或补零端口（`host:080`）、非规范的
 * 主机拼法（`0x7f.0.0.1`、百分号编码、未加方括号的 IPv6）。IDN 主机名以 punycode
 * 声明，也就是线上真正携带的形式。
 * @param entry - 待校验的输入。
 * @returns 合法时为 true。
 */
export function isBareAuthority(entry: string): boolean {
  const url = parseAuthority(entry)
  return url !== undefined && canonicalAuthority(entry) === entry.toLowerCase()
}

/**
 * 由部署参数推出公网权威，形状为 `host[:port]`。
 *
 * `vps.host` 自带端口时以它为准，`gateway.port` 不起作用——用户把端口写进地址
 * 就是在明确指定它。
 * @param host - `web-relay` 的 `vps.host`。
 * @param gatewayPort - `web-relay` 的 `gateway.port`。
 * @returns 公网权威；`vps.host` 为空或形状非法时为 undefined。
 */
export function publicAuthority(host: string, gatewayPort: number): string | undefined {
  // 先过形状校验再解析：`user@harness.internal` 会被 WHATWG 解析成一个合法 URL，
  // 但它的主机名是内嵌的那一个。设置是持久化边界（`settings.yaml` 可以被手工
  // 编辑），所以这里不能只依赖写入时的校验。
  if (!isBareAuthority(host)) return undefined
  const url = parseAuthority(host)
  if (url === undefined) return undefined
  const port = explicitPort(host, url)
  return `${url.hostname}:${port === '' ? String(gatewayPort) : port}`
}

/**
 * 权威里不带端口的那个主机名。
 *
 * Caddy 的 `default_sni` 只接受主机名，所以它不能直接吃权威。IP 字面量在这里是
 * 合法的取值：客户端对 IP 地址不发 SNI，而 Caddy 需要一个名字来挑证书。
 * @param host - `web-relay` 的 `vps.host`。
 * @returns 规范主机名；形状非法时为 undefined。
 */
export function canonicalHostname(host: string): string | undefined {
  if (!isBareAuthority(host)) return undefined
  return parseAuthority(host)?.hostname
}
