/**
 * 换票那一跳的响应形状。
 *
 * 钉住的是"Cookie 挂在一次 200 上"这条契约：Safari 不保存 3xx 响应里的
 * `Set-Cookie`（WebKit bug 186448），303 那一版会让它每一轮都像新客户端，直到报
 * 「发生了太多重定向」。测试因此断言的不是"回了个网页"，而是：状态码是 200、
 * 响应里**没有** `Location`、上游的 `Set-Cookie` 原样在这一跳上、页面自己带着回到
 * `/` 的跳转、以及循环兜底页确实会停下来。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import {
  HANDSHAKE_BLOCKED,
  HANDSHAKE_HEADER,
  HANDSHAKE_TRANSITION,
  registerEntryRoute,
} from '../lib/entry.js'

/** 全部假服务器，测试结束一起关。 */
const servers = []

after(() => {
  for (const server of servers) server.close()
})

/**
 * 起一个假的上游 dsh web。
 * @param handler - `(req, res) => void`。
 * @returns 端口。
 */
async function upstream(handler) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}

/** 收集到的一次响应。 */
function fakeResponse() {
  let settle
  const done = new Promise(resolve => { settle = resolve })
  return {
    done,
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
      settle()
    },
  }
}

/** 一次带来源地址的假请求。 */
function fakeRequest({ method = 'GET', ip = '203.0.113.9', forwarded } = {}) {
  const headers = {}
  if (forwarded !== undefined) headers['x-forwarded-for'] = forwarded
  return { method, headers, socket: { remoteAddress: ip } }
}

/**
 * 装一次入口路由，返回可直接调用的处理函数。
 * @param options - 权威、入口开关与上游端口。
 * @returns 处理函数。
 */
function mount(options) {
  let route
  const logs = []
  registerEntryRoute({
    ctx: {
      inject: (_names, callback) => {
        callback({ connection: { authenticatedUrl: base => `${base}?token=launch-token` } })
      },
    },
    webServer: {
      port: options.port,
      register: registered => { route = registered; return () => {} },
    },
    logger: { info: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    logLabel: 'dsh-web-relay',
    authority: () => options.authority ?? 'relay.example:8443',
    enabled: () => options.enabled ?? true,
  })
  return { handler: route.handler, logs, path: route.path }
}

/** 换票上游：带令牌的那一次请求回 303 与一条 DSH Cookie。 */
function exchangeUpstream() {
  return async (req, res) => {
    assert.match(req.url, /token=launch-token/u)
    assert.equal(req.headers.host, 'relay.example:8443')
    res.writeHead(303, {
      location: '/',
      'set-cookie': 'dsh-auth-abc=signature; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict',
    })
    res.end()
  }
}

test('换票成功时回 200 过渡页，Cookie 挂在这一跳上，且没有 Location', async () => {
  const port = await upstream(exchangeUpstream())
  const { handler, path } = mount({ port })
  assert.equal(path, '/relay/enter')
  const res = fakeResponse()
  handler(fakeRequest(), res)
  await res.done

  assert.equal(res.status, 200)
  assert.equal(res.headers[HANDSHAKE_HEADER], HANDSHAKE_TRANSITION)
  assert.equal(res.headers.location, undefined, '不能带 Location：带着它这一跳就还是重定向')
  assert.deepEqual(res.headers['set-cookie'], [
    'dsh-auth-abc=signature; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict',
  ])
  assert.match(res.headers['content-type'], /text\/html/u)
  // 页面自己回到干净的 `/`：meta refresh 管脚本被禁的情况，location.replace 管常规情况。
  assert.match(res.body, /<meta http-equiv="refresh" content="0; url=\/">/u)
  assert.match(res.body, /location\.replace\("\/"\)/u)
  // 过渡页不该泄漏任何凭据。
  assert.doesNotMatch(res.body, /launch-token/u)
})

test('上游不是 303 时如实报 502，不伪造成功', async () => {
  const port = await upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  const { handler } = mount({ port })
  const res = fakeResponse()
  handler(fakeRequest(), res)
  await res.done

  assert.equal(res.status, 502)
  assert.match(res.body, /期望 303/u)
})

test('同一来源反复落在换票点上时停下来给说明页，换一个来源不受影响', async () => {
  const port = await upstream(exchangeUpstream())
  const { handler, logs } = mount({ port })

  // 前 5 次照常给过渡页。
  for (let i = 0; i < 5; i += 1) {
    const res = fakeResponse()
    handler(fakeRequest({ ip: '198.51.100.7' }), res)
    await res.done
    assert.equal(res.headers[HANDSHAKE_HEADER], HANDSHAKE_TRANSITION, `第 ${String(i + 1)} 次不该被拦`)
  }

  const blocked = fakeResponse()
  handler(fakeRequest({ ip: '198.51.100.7' }), blocked)
  await blocked.done
  assert.equal(blocked.status, 200)
  assert.equal(blocked.headers[HANDSHAKE_HEADER], HANDSHAKE_BLOCKED)
  assert.equal(blocked.headers.location, undefined)
  assert.doesNotMatch(blocked.body, /http-equiv="refresh"/u, '兜底页不能再跳回去，否则还是转圈')
  assert.match(blocked.body, /Cookie/u)
  assert.match(blocked.body, /relay\.example:8443/u)
  assert.ok(logs.some(line => line.includes('已停止带路')), '兜底要留下一条日志')

  // 另一个来源是另一条循环，仍然照常换票。
  const other = fakeResponse()
  handler(fakeRequest({ ip: '198.51.100.8' }), other)
  await other.done
  assert.equal(other.headers[HANDSHAKE_HEADER], HANDSHAKE_TRANSITION)
})

test('X-Forwarded-For 的第一段就是循环计数用的来源', async () => {
  const port = await upstream(exchangeUpstream())
  const { handler } = mount({ port })
  for (let i = 0; i < 5; i += 1) {
    const res = fakeResponse()
    handler(fakeRequest({ forwarded: '203.0.113.1, 10.0.0.1' }), res)
    await res.done
  }
  const blocked = fakeResponse()
  handler(fakeRequest({ forwarded: '203.0.113.1, 10.0.0.1' }), blocked)
  await blocked.done
  assert.equal(blocked.headers[HANDSHAKE_HEADER], HANDSHAKE_BLOCKED)
})

test('入口关掉时回 403 说明，不换票', async () => {
  const port = await upstream(() => { throw new Error('关掉时不该打上游') })
  const { handler } = mount({ port, enabled: false })
  const res = fakeResponse()
  handler(fakeRequest(), res)
  await res.done
  assert.equal(res.status, 403)
})

test('还没配置地址时回 503 说明', async () => {
  const port = await upstream(exchangeUpstream())
  const { handler } = mount({ port, authority: '' })
  const res = fakeResponse()
  handler(fakeRequest(), res)
  await res.done
  assert.equal(res.status, 503)
})

test('非 GET 回 405', async () => {
  const port = await upstream(exchangeUpstream())
  const { handler } = mount({ port })
  const res = fakeResponse()
  handler(fakeRequest({ method: 'POST' }), res)
  await res.done
  assert.equal(res.status, 405)
})
