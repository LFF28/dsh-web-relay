/**
 * 权威的生效与自检。
 *
 * 权威是插件唯一一处"别人替我判断对错"的地方：DSH 的 Host/Origin 围栏按它的
 * 受信列表决定 403 还是放行，浏览器 Cookie 的名字与签名负载也绑定它。所以这里的
 * 两件事都围绕"我怎么知道它真的生效了"——重解析 `connection` 行，然后立刻从
 * 回环地址探一次。
 * @module dsh-web-relay/trust
 */

import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { HANDSHAKE_HEADER, HANDSHAKE_TRANSITION } from './entry.js'
import type { RelayLogger } from './tunnel.js'

/** 一次自检的结论。 */
export interface SelfCheck {
  /** 是否通过。 */
  readonly ok: boolean
  /** 一句话说明，写进记录与日志。 */
  readonly detail: string
}

/**
 * 让 `connection` 行按插件提供的权威重新解析自己的配置。
 *
 * 走的是"重解析"而不是"改写"：配置文件里那一行是
 * `trustedHosts: !!js [...ctx.webRuntime.trustedHosts, ...ctx.webRelay.trustedHosts]`
 * 这样的表达式，插件只提供一个服务面，表达式在求值时把权威取走。`noSave = true`
 * 保证解析出的字面量不会把表达式覆盖掉。
 */
export class Trust {
  /**
   * @param ctx - 插件上下文；用它拿 `loader`。
   * @param logger - 日志。
   * @param logLabel - 日志前缀。
   */
  constructor(
    private readonly ctx: Context,
    private readonly logger: RelayLogger,
    private readonly logLabel: string,
  ) {}

  /**
   * 触发 `connection` 行重解析。
   *
   * 刻意不 await：`Fiber.update` 把重启交给 `internal/update` 瀑布，返回值是
   * `void`。等它不是这里的职责——真正判断生效与否的是随后的自检。
   */
  apply(): void {
    let entry: { options: { config: unknown }; fiber?: { update(config: unknown, noSave?: boolean): void } }
    try {
      entry = this.ctx.loader.resolve('connection') as typeof entry
    } catch (error) {
      this.logger.warn('%s 找不到 connection 行，权威没有生效：%s', this.logLabel, describe(error))
      return
    }
    if (entry.fiber === undefined) {
      // 行还没起来：它首次解析配置时插件已经 provide 过服务面，会自己取到权威。
      this.logger.info('%s connection 行尚未启动，权威会在它解析配置时生效', this.logLabel)
      return
    }
    entry.fiber.update(entry.options.config, true)
    this.logger.info('%s 已触发 connection 行重解析，使权威进入 Host/Origin 围栏', this.logLabel)
  }

  /**
   * 本机自检：从回环地址打一次 `/api`，`Host` 用公网权威。
   *
   * 期望 **401**。403 是"权威没进受信列表"的确定信号——围栏在认证之前，所以只要
   * 权威生效，未带 Cookie 的请求必然是 401。这条断言把"手机打不开"提前到终端里。
   * @param authority - 公网权威。
   * @param dshPort - 本机 dsh web 端口。
   * @param timeoutMs - 超时。
   * @returns 结论。
   */
  async selfCheck(authority: string, dshPort: number, timeoutMs: number): Promise<SelfCheck> {
    const status = await httpStatus({
      host: '127.0.0.1',
      port: dshPort,
      path: '/api/',
      headers: { host: authority },
      timeoutMs,
    })
    if (status === 403) {
      return { ok: false, detail: `权威 ${authority} 没有进入围栏的受信列表（loopback 请求返回 403）` }
    }
    if (status === 401) {
      return { ok: true, detail: `权威 ${authority} 已生效（loopback /api 返回 401：围栏放行、认证拒绝）` }
    }
    return { ok: false, detail: `权威自检得到意外状态码 ${String(status)}（期望 401）` }
  }

  /**
   * 公网自检：走真实 HTTPS，按浏览器的顺序走一遍首访。
   *
   * 三跳：不带任何头打一次 `/`（期望 401 或 200，证明链路上有人应答）；带网关会话
   * Cookie 与文档导航的 `Accept` 再打一次（期望 200 且带换票标记头 —— 中继把这次
   * 导航在内部改写成换票点，插件换了票并回一页过渡页）；最后带着换来的 DSH Cookie
   * 打第三次（期望 200 —— 权威绑定的 Cookie 被接受）。
   *
   * 中间那一跳**必须是 200 而不是 303**：Safari 不保存 3xx 响应上的 `Set-Cookie`，
   * 303 会让它每一轮都像新客户端，直到报「发生了太多重定向」。这条断言把那个故障
   * 挡在部署阶段；只认状态码不够（过渡页与界面都是 200），所以同时认标记头。
   *
   * 入口关掉时中间那一跳期望 403：改写照样发生，差别只在换票点答一段说明。拿到
   * 200 说明开关没生效，那等于把关掉的入口又打开了一次。
   *
   * 会话密钥是这几跳里唯一的凭据：它绕开网关口令，因此探测本身不产生口令失败、
   * 不喂 fail2ban，也不把口令发到公网。它是公网上唯一的密文凭据，所以只在根证书
   * 已取回、对端身份可校验时才发出去。
   * @param authority - 公网权威。
   * @param caCertPath - 本机保存的根证书路径。
   * @param timeoutMs - 单次请求超时。
   * @param inputs - 会话密钥与入口开关。
   * @returns 结论。
   */
  async publicProbe(
    authority: string,
    caCertPath: string,
    timeoutMs: number,
    inputs: PublicProbeInputs,
  ): Promise<SelfCheck> {
    let ca: Buffer | undefined
    try {
      ca = await readFile(caCertPath)
    } catch {
      // 还没引导到第 10 步；下面的结论会说明这一点。
      ca = undefined
    }
    const parsed = new URL(`https://${authority}/`)
    const target = {
      host: parsed.hostname,
      port: Number(parsed.port === '' ? '443' : parsed.port),
      timeoutMs,
      ca,
    }
    const trust = ca === undefined ? '未校验对端身份（本地没有根证书副本）' : '已用本地根证书校验对端身份'
    const bare = await httpsResponse({ ...target, path: '/', headers: { host: authority } })
    if (bare.status === undefined) {
      return { ok: false, detail: `公网请求 ${authority} 没有得到 HTTP 响应` }
    }
    if (bare.status !== 401 && bare.status !== 200) {
      return { ok: false, detail: `公网入口返回 ${String(bare.status)}（期望 401 或 200；${trust}）` }
    }
    const head = `公网入口返回 ${String(bare.status)}（${trust}）`

    if (ca === undefined) {
      return { ok: true, detail: `${head}；未验证裸地址带路（不把会话密钥发到未校验身份的连接上）` }
    }
    const session = `relay_session=${inputs.sessionSecret}`
    const entered = await httpsResponse({
      ...target,
      path: '/',
      headers: { host: authority, cookie: session, accept: 'text/html' },
    })
    if (!inputs.entryEnabled) {
      return entered.status === 403
        ? { ok: true, detail: `${head}；入口已关闭，裸地址给出的是说明而不是界面` }
        : {
            ok: false,
            detail: `${head}；入口已关闭，裸地址却${describeStatus(entered.status)}（期望 403）：开关没生效，重新引导一次`,
          }
    }
    if (entered.status !== 200) {
      return {
        ok: false,
        detail: `${head}；裸地址没有带路（${describeStatus(entered.status)}，期望 200 过渡页）：中继上的 Caddyfile 还没有这条改写，重新引导一次`,
      }
    }
    if (entered.handshake !== HANDSHAKE_TRANSITION) {
      return {
        ok: false,
        detail: `${head}；换票那一跳回的 200 不是过渡页（${HANDSHAKE_HEADER}: ${entered.handshake ?? '（没有这个头）'}）：中继上跑的还是旧版插件，重新部署一次`,
      }
    }
    const mintedRaw = cookieOf(entered.setCookie, 'dsh-auth-')
    if (mintedRaw === undefined) {
      return {
        ok: false,
        detail: `${head}；换票的过渡页里没有 DSH 会话 Cookie：中继上的 Caddyfile 是旧版，重新引导一次`,
      }
    }
    if (!/;\s*Secure(?:;|$)/iu.test(mintedRaw)) {
      return {
        ok: false,
        detail: `${head}；换来的 DSH 会话 Cookie 没有 Secure：中继没给上游的 Set-Cookie 补上这一位`,
      }
    }
    const minted = mintedRaw.split(';', 1)[0] ?? ''
    const opened = await httpsResponse({
      ...target,
      path: '/',
      headers: { host: authority, cookie: `${session}; ${minted}`, accept: 'text/html' },
    })
    if (opened.status !== 200) {
      return {
        ok: false,
        detail: `${head}；换来的会话 Cookie 被拒（GET / ${describeStatus(opened.status)}，期望 200）`,
      }
    }
    return {
      ok: true,
      detail: `${head}；裸地址直接进入界面（换票一页过渡页、会话 Cookie 带 Secure、换来 200）`,
    }
  }
}

/** {@link Trust.publicProbe} 的输入。 */
export interface PublicProbeInputs {
  /** 网关会话密钥；等价于一次口令通过，用于绕开口令提示走到上游。 */
  readonly sessionSecret: string
  /** `/relay/enter` 是否换票。为假时它回 403 说明，中继侧的改写与跳转不变。 */
  readonly entryEnabled: boolean
}

/** 一次 HTTP 探测的规格。 */
interface HttpProbeSpec {
  /** 目标主机。 */
  readonly host: string
  /** 目标端口。 */
  readonly port: number
  /** 请求路径。 */
  readonly path: string
  /** 请求头。 */
  readonly headers: Record<string, string>
  /** 超时。 */
  readonly timeoutMs: number
}

/** 一次 HTTPS 探测的规格。 */
interface HttpsProbeSpec extends HttpProbeSpec {
  /** 用于校验对端身份的根证书；缺省表示不校验。 */
  readonly ca: Buffer | undefined
}

/**
 * 打一次明文 HTTP，只取状态码。
 *
 * 用 `node:http` 而不是 `fetch`：`Host` 是 fetch 规范里的禁止修改头，而这里要证的
 * 恰恰是 Host 决定的事。
 * @param spec - 探测规格。
 * @returns 状态码；连不上或超时时为 0。
 */
async function httpStatus(spec: HttpProbeSpec): Promise<number> {
  return await new Promise<number>((resolve) => {
    const req = httpRequest({
      host: spec.host,
      port: spec.port,
      path: spec.path,
      method: 'GET',
      headers: { ...spec.headers, connection: 'close' },
      timeout: spec.timeoutMs,
    }, (res) => {
      res.resume()
      res.on('end', () => { resolve(res.statusCode ?? 0) })
    })
    req.on('timeout', () => { req.destroy() })
    req.on('error', () => { resolve(0) })
    req.end()
  })
}

/**
 * 打一次 HTTPS，取状态码与全部 `Set-Cookie`。
 * @param spec - 探测规格。
 * @returns 两项响应事实；连不上、超时或证书校验失败时状态码为 undefined。
 */
async function httpsResponse(spec: HttpsProbeSpec): Promise<HttpsResponse> {
  return await new Promise<HttpsResponse>((resolve) => {
    const req = httpsRequest({
      host: spec.host,
      port: spec.port,
      path: spec.path,
      method: 'GET',
      headers: { ...spec.headers, connection: 'close' },
      timeout: spec.timeoutMs,
      ...spec.ca === undefined ? {} : { ca: spec.ca },
    }, (res) => {
      const setCookie = res.headers['set-cookie'] ?? []
      const handshake = res.headers[HANDSHAKE_HEADER]
      res.resume()
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          setCookie: Array.isArray(setCookie) ? setCookie : [setCookie],
          handshake: typeof handshake === 'string' ? handshake : undefined,
        })
      })
    })
    req.on('timeout', () => { req.destroy() })
    req.on('error', () => { resolve({ status: undefined, setCookie: [], handshake: undefined }) })
    req.end()
  })
}

/** 一次 HTTPS 探测拿到的响应事实。 */
interface HttpsResponse {
  /** 状态码；连不上、超时或证书校验失败时为 undefined。 */
  readonly status: number | undefined
  /** 全部 `Set-Cookie`。 */
  readonly setCookie: readonly string[]
  /** `x-dsh-web-relay-handshake` 的值；没有这个头时为 undefined。 */
  readonly handshake: string | undefined
}

/**
 * 从一组 `Set-Cookie` 里取名字带指定前缀的那一条原文（含属性）。
 * @param setCookie - 响应里的 `Set-Cookie`。
 * @param prefix - Cookie 名字前缀。
 * @returns 那一条 `Set-Cookie`；没有匹配时为 undefined。
 */
function cookieOf(setCookie: readonly string[], prefix: string): string | undefined {
  return setCookie.find(raw => raw.startsWith(prefix))
}

/**
 * 把状态码压成一句可直接读的话。
 * @param status - 状态码；undefined 表示没有响应。
 * @returns 供 detail 使用的片段。
 */
function describeStatus(status: number | undefined): string {
  return status === undefined ? '没有得到 HTTP 响应' : `返回 ${String(status)}`
}

/**
 * 把任意抛出物压成一行可读文本。
 * @param error - 抛出物。
 * @returns 一行摘要。
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
