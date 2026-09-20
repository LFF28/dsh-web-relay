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
   * 公网自检：走真实 HTTPS 打一次根路径。
   *
   * 期望 401（未带网关口令）或 200（带了）。根证书已取到时校验对端身份；没取到
   * 就退回不校验，并把这一点写进结论——那时的证据只说明"链路上有人应答"。
   * @param authority - 公网权威。
   * @param caCertPath - 本机保存的根证书路径。
   * @param timeoutMs - 超时。
   * @returns 结论。
   */
  async publicProbe(authority: string, caCertPath: string, timeoutMs: number): Promise<SelfCheck> {
    let ca: Buffer | undefined
    try {
      ca = await readFile(caCertPath)
    } catch {
      // 还没引导到第 10 步；下面的结论会说明这一点。
      ca = undefined
    }
    const parsed = new URL(`https://${authority}/`)
    const status = await httpsStatus({
      host: parsed.hostname,
      port: Number(parsed.port === '' ? '443' : parsed.port),
      path: '/',
      headers: { host: authority },
      timeoutMs,
      ca,
    })
    if (status === undefined) {
      return { ok: false, detail: `公网请求 ${authority} 没有得到 HTTP 响应` }
    }
    const trust = ca === undefined ? '未校验对端身份（本地没有根证书副本）' : '已用本地根证书校验对端身份'
    if (status === 401 || status === 200) {
      return { ok: true, detail: `公网入口返回 ${String(status)}（${trust}）` }
    }
    return { ok: false, detail: `公网入口返回 ${String(status)}（期望 401 或 200；${trust}）` }
  }
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
 * 打一次 HTTPS，只取状态码。
 * @param spec - 探测规格。
 * @returns 状态码；连不上、超时或证书校验失败时为 undefined。
 */
async function httpsStatus(spec: HttpsProbeSpec): Promise<number | undefined> {
  return await new Promise<number | undefined>((resolve) => {
    const req = httpsRequest({
      host: spec.host,
      port: spec.port,
      path: spec.path,
      method: 'GET',
      headers: { ...spec.headers, connection: 'close' },
      timeout: spec.timeoutMs,
      ...spec.ca === undefined ? {} : { ca: spec.ca },
    }, (res) => {
      res.resume()
      res.on('end', () => { resolve(res.statusCode ?? 0) })
    })
    req.on('timeout', () => { req.destroy() })
    req.on('error', () => { resolve(undefined) })
    req.end()
  })
}

/**
 * 把任意抛出物压成一行可读文本。
 * @param error - 抛出物。
 * @returns 一行摘要。
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
