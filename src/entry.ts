/**
 * 换票点：公网 HTTP 面上唯一一条属于插件的路由。
 *
 * `/relay/enter` 是"用网关口令换到 DSH 会话"的那一步。它的做法是让插件自己去
 * 完成一次本机的令牌交换，再把结果原样转给浏览器：插件因此永远不接触 DSH 的
 * Cookie 签名密钥，也不需要把启动令牌写到任何地方。
 *
 * 操作者不需要知道这条路径：中继把"没带 DSH 会话 Cookie 的文档导航"在内部改写到
 * 它（`deploy/Caddyfile.snippet` 的 `@noDsh`），浏览器地址栏里始终只有裸权威；只有
 * 带着一个已失效的 DSH Cookie 时，中继才会用一次可见的跳转把浏览器送到这里。
 *
 * 换票成功后回的是 **200 过渡页，不是 303**。DSH 的会话 Cookie 只能挂在一次响应
 * 上，而 Safari 不保存 3xx 响应里的 `Set-Cookie`（WebKit bug 186448，2018 年报出、
 * 至今未修）：303 会让 Safari 每一轮都像新客户端，中继重新改写、换票点又回一个
 * 303，直到它报「发生了太多重定向」。200 是普通响应，Cookie 照常入账，页面自己用
 * 一条 `meta refresh` 与一行 `location.replace` 回到干净的 `/`。
 *
 * 根证书不经过公网：引导第 10 步把中继上生成的根证书直接取回本机保存，交给设备
 * 时走的是不依赖 TLS 信任的渠道（本机直接拷、隔空投送、消息应用）。公网因此只有
 * 一条路径，而"用还需要根证书的连接去取根证书"这个循环也不存在。
 * @module dsh-web-relay/entry
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { RelayLogger } from './tunnel.js'

/** 换票点路径：中继把没带 DSH 会话 Cookie 的文档导航内部改写到这里，它不进地址栏。 */
export const ENTER_PATH = '/relay/enter'

/**
 * 换票响应的标记头。
 *
 * 值是 `transition`。过渡页与界面在状态码上不再可区分——两者都是 200——所以自检与
 * 排查都靠这个头确认"换票这一跳真的发生过"。它不含任何秘密。
 */
export const HANDSHAKE_HEADER = 'x-dsh-web-relay-handshake'

/** {@link HANDSHAKE_HEADER} 的取值。 */
export const HANDSHAKE_TRANSITION = 'transition'

/** {@link HANDSHAKE_HEADER} 在循环兜底页上的取值。 */
export const HANDSHAKE_BLOCKED = 'blocked'

/** 循环窗口：同一个客户端在这段时间内反复落在换票点上就按循环处理。 */
const LOOP_WINDOW_MS = 30_000

/** 窗口内允许的次数。正常客户端只落一次，公网自检每次部署也只用一次。 */
const LOOP_LIMIT = 5

/** 计数表的软上限；超限时顺手清掉过期项，避免被伪造来源撑大。 */
const LOOP_KEYS_MAX = 1024

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
  /** 公网权威；为空字符串表示尚未配置。 */
  authority(): string
  /**
   * `entry.enabled`。
   *
   * 路由始终注册，开关只决定它答什么：中继侧的改写与跳转都指向这条路径，路径不存在
   * 时浏览器会在 401 与 302 之间来回，那比"入口关掉了"难查得多。
   */
  enabled(): boolean
}

/** 只用到 `connection` 服务的一个方法，避免把整个服务类拉进类型里。 */
interface AuthenticatedUrlSource {
  authenticatedUrl(baseUrl: string): string
}

/**
 * 注册入口路由。
 *
 * 注册必须同步发生（`ctx.webServer.register` 返回一个同步的释放器），因此这里
 * 返回释放器而不是 Promise。
 * @param deps - 依赖。
 * @returns 释放入口路由的函数。
 */
export function registerEntryRoute(deps: EntryDeps): () => void {
  // `connection` 与 `web-relay` 之间有真实的相互依赖：插件要它来换令牌，而它要
  // 插件的服务面来算受信列表。挂在模块级 `inject` 上会死锁，所以这里用一个子
  // fiber 等它就绪——子 fiber 的等待不影响插件自身的激活。
  let connection: AuthenticatedUrlSource | undefined
  deps.ctx.inject(['connection'], (connectionCtx) => {
    connection = connectionCtx.connection as unknown as AuthenticatedUrlSource
    deps.logger.info('%s 已接上 connection 服务，%s 可以换会话了', deps.logLabel, ENTER_PATH)
  })

  // 循环计数挂在这个注册闭包里，随路由一起释放：它描述的是"这条路由被同一批客户端
  // 反复命中"，不是插件的长期状态。
  const loop = createLoopGuard()

  return deps.webServer.register({
    kind: 'exact',
    path: ENTER_PATH,
    handler: (req, res) => { void handleEnter(deps, connection, loop, req, res) },
  })
}

/**
 * 换会话：本机令牌交换 + 把结果转给浏览器。
 *
 * 成功时回 200 过渡页而不是 303：见模块头对 Safari 与 3xx 上 `Set-Cookie` 的说明。
 * 页面里的跳转目标是 `/`（`LOCATION`），而不是带令牌的地址——令牌交换已经完成，
 * 浏览器下一次请求只需要带上刚拿到的 Cookie。
 * @param deps - 依赖。
 * @param connection - `connection` 服务；尚未就绪时为 undefined。
 * @param loop - 循环计数；同一客户端反复落在换票点上时改答说明页。
 * @param req - 原始请求。
 * @param res - 响应。
 */
async function handleEnter(
  deps: EntryDeps,
  connection: AuthenticatedUrlSource | undefined,
  loop: LoopGuard,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
    res.end('只接受 GET\n')
    return
  }
  if (!deps.enabled()) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('dsh-web-relay: 入口已关闭（entry.enabled = false）\n')
    return
  }
  const authority = deps.authority()
  if (authority === '') {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('dsh-web-relay: 还没有配置中继地址，请先在本机的 设置 ▸ 远程访问 里填好并点一次部署\n')
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
    // 这一页本身就是"Cookie 没能入账"的证据：浏览器带着 DSH 会话 Cookie 时中继不会
    // 把它改写到这里。所以同一来源反复落在换票点上只可能是浏览器存不下 Cookie，再
    // 转下去就是无限循环——停下来给一段能读的说明。
    const visits = loop.hit(clientKey(req))
    if (visits > LOOP_LIMIT) {
      deps.logger.warn('%s %s 在 %d 秒内第 %d 次落在换票点上，已停止带路（DSH 会话 Cookie 没能留在浏览器里）',
        deps.logLabel, ENTER_PATH, Math.round(LOOP_WINDOW_MS / 1000), visits)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        [HANDSHAKE_HEADER]: HANDSHAKE_BLOCKED,
      })
      res.end(blockedPage(authority))
      return
    }
    const headers: Record<string, string | string[]> = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      [HANDSHAKE_HEADER]: HANDSHAKE_TRANSITION,
    }
    if (upstream.setCookie.length > 0) headers['set-cookie'] = upstream.setCookie
    res.writeHead(200, headers)
    res.end(transitionPage())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.logger.warn('%s %s 换会话失败：%s', deps.logLabel, ENTER_PATH, message)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('dsh-web-relay: 无法从本机 dsh web 换取会话，请确认承载它的进程还在运行\n')
  }
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

/**
 * 过渡页：Cookie 已随这次 200 下发，页面负责把浏览器送回干净的 `/`。
 *
 * `meta refresh` 与 `location.replace` 都给上：前者在脚本被禁时仍然工作，后者让
 * 常规浏览器立刻跳转且不往历史里塞一条记录。正文只有一行，没有脚本以外的资源，
 * 因此这一跳不依赖静态资源，也不受页面是否渲染的影响。
 * @returns 过渡页 HTML。
 */
function transitionPage(): string {
  return page('正在进入 dsh web…')
}

/**
 * 循环兜底页。
 *
 * 走到这里说明 DSH 的会话 Cookie 没能留在浏览器里，再跳下去只会让它自己报「发生了
 * 太多重定向」。这一页说清现象，并给出两个能动手的做法。
 * @param authority - 公网权威，用于提示换浏览器/清站点数据的对象。
 * @returns 说明页 HTML。
 */
function blockedPage(authority: string): string {
  return page(
    '无法保持登录状态',
    `<p>浏览器没有保存 dsh web 的会话 Cookie，重复跳转不会成功，已在这里停下。</p>
<p>常见原因是浏览器禁用了该站点的 Cookie，或隐私设置把它当作第三方数据清掉了。</p>
<p>可以这样恢复：</p>
<ul>
<li>在浏览器设置里允许 <code>${escapeHtml(authority)}</code> 使用 Cookie，然后重新打开 https://${escapeHtml(authority)}/ ；</li>
<li>或换一个浏览器（Chromium 系或 Firefox）打开同一个地址。</li>
</ul>
<p>若仍打不开，请在本机 <code>dsh --profile &lt;你的 profile&gt;</code> 的日志里查看换票记录。</p>`,
  )
}

/**
 * 一页极简 HTML。
 * @param title - 标题，同时作为可见文字。
 * @param body - 追加的正文；省略时为过渡页。
 * @returns 完整 HTML。
 */
function page(title: string, body?: string): string {
  const jump = '<meta http-equiv="refresh" content="0; url=/">'
    + '<script>location.replace("/")</script>'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${body === undefined ? jump : ''}
</head>
<body style="font:16px/1.6 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1.25rem">
<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>
${body ?? ''}
</body>
</html>
`
}

/**
 * 把一段文本放进 HTML 文本节点。
 * 只有权威与固定文案会经过这里，但仍然转义：它来自用户的部署参数。
 * @param text - 原文。
 * @returns 转义后的文本。
 */
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** 同一客户端的循环计数。 */
interface LoopGuard {
  /**
   * 记一次命中。
   * @param key - 客户端标识。
   * @returns 窗口内累计到本次的次数。
   */
  hit(key: string): number
}

/**
 * 造一个按客户端标识计数的窗口计数器。
 *
 * 中继已经把来源地址写进 `X-Forwarded-For` 之外的地方（Caddy 直连，日志里记的是真实
 * 来源），这里只取 `X-Forwarded-For` 的第一段，取不到就退到 socket 地址。键只用来
 * 合并同一次循环，不参与任何授权判断。
 * @returns 计数器。
 */
function createLoopGuard(): LoopGuard {
  const hits = new Map<string, { count: number; expiresAt: number }>()
  return {
    hit(key: string): number {
      const now = Date.now()
      if (hits.size >= LOOP_KEYS_MAX) {
        for (const [existing, entry] of hits) {
          if (entry.expiresAt <= now) hits.delete(existing)
        }
      }
      const current = hits.get(key)
      if (current === undefined || current.expiresAt <= now) {
        hits.set(key, { count: 1, expiresAt: now + LOOP_WINDOW_MS })
        return 1
      }
      current.count += 1
      return current.count
    },
  }
}

/**
 * 取这次请求的客户端标识。
 * @param req - 原始请求。
 * @returns 标识；两者都取不到时为空字符串（同一次循环仍然合并到一起）。
 */
function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  if (first !== undefined && first !== '') return first
  return req.socket.remoteAddress ?? ''
}
