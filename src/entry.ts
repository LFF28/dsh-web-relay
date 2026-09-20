/**
 * 公网入口的两条路由。
 *
 * `/relay/enter` 是"用网关口令换到 DSH 会话"的那一步。它的做法是让插件自己去
 * 完成一次本机的令牌交换，再把结果原样转给浏览器：插件因此永远不接触 DSH 的
 * Cookie 签名密钥，也不需要把启动令牌写到任何地方。
 *
 * `/relay/ca.crt` 只是把引导第 10 步取回的根证书发出去。它同样落在网关口令之后：
 * 走到这一步时 TLS 信任已经建立，多一个免认证的端点换不到任何东西，而少一个就
 * 少一条被扫描面。第一次把根证书交给手机走的是**不依赖 TLS 信任**的渠道（本机
 * 直接拷、隔空投送、消息应用），因为"用还需要根证书的连接去取根证书"是循环。
 * @module dsh-web-relay/entry
 */

import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { RelayLogger } from './tunnel.js'

/** 公网入口路径：换会话。 */
export const ENTER_PATH = '/relay/enter'

/** 公网入口路径：取根证书。 */
export const CA_PATH = '/relay/ca.crt'

/** 入口的依赖。 */
export interface EntryDeps {
  /** 插件上下文；用它把 `connection` 作为一个子 fiber 注入，避免与它互相等待。 */
  readonly ctx: Context
  /** 路由载体。 */
  readonly webServer: WebServer
  /** 日志。 */
  readonly logger: RelayLogger
  /** 日志前缀。 */
  readonly logLabel: string
  /** 本机保存的根证书路径。 */
  readonly caCertPath: string
  /** 公网权威；为空字符串表示尚未配置。 */
  authority(): string
}

/** 只用到 `connection` 服务的一个方法，避免把整个服务类拉进类型里。 */
interface AuthenticatedUrlSource {
  authenticatedUrl(baseUrl: string): string
}

/**
 * 注册两条入口路由。
 *
 * 注册必须同步发生（`ctx.webServer.register` 返回一个同步的释放器），因此这里
 * 返回释放器而不是 Promise。
 * @param deps - 依赖。
 * @returns 释放两条路由的函数。
 */
export function registerEntryRoutes(deps: EntryDeps): () => void {
  // `connection` 与 `web-relay` 之间有真实的相互依赖：插件要它来换令牌，而它要
  // 插件的服务面来算受信列表。挂在模块级 `inject` 上会死锁，所以这里用一个子
  // fiber 等它就绪——子 fiber 的等待不影响插件自身的激活。
  let connection: AuthenticatedUrlSource | undefined
  deps.ctx.inject(['connection'], (connectionCtx) => {
    connection = connectionCtx.connection as unknown as AuthenticatedUrlSource
    deps.logger.info('%s 已接上 connection 服务，%s 可以换会话了', deps.logLabel, ENTER_PATH)
  })

  const disposeEnter = deps.webServer.register({
    kind: 'exact',
    path: ENTER_PATH,
    handler: (req, res) => { void handleEnter(deps, connection, req, res) },
  })
  const disposeCa = deps.webServer.register({
    kind: 'exact',
    path: CA_PATH,
    handler: (req, res) => { void handleCa(deps, req, res) },
  })
  return () => {
    disposeEnter()
    disposeCa()
  }
}

/**
 * 换会话：本机令牌交换 + 把结果转给浏览器。
 * @param deps - 依赖。
 * @param connection - `connection` 服务；尚未就绪时为 undefined。
 * @param req - 原始请求。
 * @param res - 响应。
 */
async function handleEnter(
  deps: EntryDeps,
  connection: AuthenticatedUrlSource | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
    res.end('只接受 GET\n')
    return
  }
  const authority = deps.authority()
  if (authority === '') {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('dsh-web-relay: 还没有配置中继地址，请先在本机的「Web Relay」卡片里填好并保存\n')
    return
  }
  if (connection === undefined) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('dsh-web-relay: DSH 的连接服务尚未就绪，请稍后重试\n')
    return
  }
  const port = deps.webServer.port
  try {
    const tokenUrl = new URL(connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`))
    const upstream = await exchange(tokenUrl, authority)
    if (upstream.status !== 303) {
      // 令牌交换没给出重定向，说明本机那一次请求没被认成"带令牌的根请求"。
      // 把上游的状态码如实报出来，而不是伪造一个成功。
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`dsh-web-relay: 本机令牌交换得到 ${String(upstream.status)}（期望 303）\n`)
      deps.logger.warn('%s %s 的本机令牌交换得到 %d', deps.logLabel, ENTER_PATH, upstream.status)
      return
    }
    const headers: Record<string, string | string[]> = {
      location: '/',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    }
    if (upstream.setCookie.length > 0) headers['set-cookie'] = upstream.setCookie
    res.writeHead(303, headers)
    res.end()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.logger.warn('%s %s 换会话失败：%s', deps.logLabel, ENTER_PATH, message)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('dsh-web-relay: 无法从本机 dsh web 换取会话，请确认承载它的进程还在运行\n')
  }
}

/**
 * 把根证书发出去。没有引导过时返回 404——"还没准备好"是正常状态，不是错误。
 * @param deps - 依赖。
 * @param req - 原始请求。
 * @param res - 响应。
 */
async function handleCa(deps: EntryDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    res.end('只接受 GET\n')
    return
  }
  let pem: Buffer
  try {
    pem = await readFile(deps.caCertPath)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('dsh-web-relay: 还没有中继根证书，请先在本机完成引导\n')
    return
  }
  res.writeHead(200, {
    'content-type': 'application/x-x509-ca-cert',
    'content-length': String(pem.byteLength),
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') res.end()
  else res.end(pem)
}

/** 一次本机令牌交换的结果。 */
interface ExchangeResult {
  /** 上游状态码。 */
  readonly status: number
  /** 上游给出的全部 `Set-Cookie`。 */
  readonly setCookie: string[]
}

/**
 * 对本机 dsh web 打一次带令牌的根请求。
 *
 * `Host` 必须是公网权威：令牌换来的 Cookie 把权威签进负载，而权威取自请求的 Host。
 * 用 `node:http` 而不是 `fetch`，因为 fetch 规范禁止设置 `Host`。
 * @param tokenUrl - 带 `?token=` 的本机 URL。
 * @param authority - 公网权威。
 * @returns 状态码与 `Set-Cookie`。
 */
async function exchange(tokenUrl: URL, authority: string): Promise<ExchangeResult> {
  return await new Promise<ExchangeResult>((resolve, reject) => {
    const req = httpRequest({
      host: tokenUrl.hostname,
      port: tokenUrl.port,
      path: `${tokenUrl.pathname}${tokenUrl.search}`,
      method: 'GET',
      headers: { host: authority, connection: 'close' },
      timeout: 10000,
    }, (res) => {
      const setCookie = res.headers['set-cookie'] ?? []
      res.resume()
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, setCookie: Array.isArray(setCookie) ? setCookie : [setCookie] })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('本机令牌交换超时')) })
    req.on('error', reject)
    req.end()
  })
}
