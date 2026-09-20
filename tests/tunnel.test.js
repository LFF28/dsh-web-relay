/**
 * 隧道的进程生命周期。
 *
 * 两条性质把「收干净」钉在测试里，它们的反面都在真机上出现过：
 *   1. `stop()` 必须等进程范围空掉才返回。中继侧的转发端点在服务端，进程还在时端点
 *      还在，紧接着起的那条连接会以 `ExitOnForwardFailure` 失败。
 *   2. 一条不落定的 `done` 不能把状态永远钉在 `running`。只等 `done` 时，进程早就没
 *      了、端口上什么都没有，卡片却显示已连接。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Tunnel } from '../lib/tunnel.js'

/** 造一份能喂给 `Tunnel` 的部署参数。 */
function deployment() {
  return {
    host: 'relay.example',
    sshPort: 22,
    user: 'ubuntu',
    identityFile: '/tmp/relay_key',
    hostKeyFingerprint: undefined,
    gatewayPort: 8443,
    password: 'p',
    autoStart: true,
    bootstrapRequest: 0,
    authority: 'relay.example:8443',
    hostname: 'relay.example',
  }
}

/**
 * 一个可控的假进程句柄：`done` 永不落定，进程范围由 `releaseRange` 手动放行，
 * 也就是「ssh 还活着」的默认形状。
 * @param options - `releaseOnWait: true` 让 `waitForExit` 立刻以「范围已空」落定；
 *   `rejectOnWait: true` 让它抛出，模拟提供者失去观测能力。
 * @returns 句柄与调用记录、放行方法。
 */
function fakeHandle(options = {}) {
  const calls = { terminate: 0, waitForExit: 0 }
  let releaseRange
  const range = new Promise((resolve) => { releaseRange = resolve })
  return {
    calls,
    handle: {
      done: new Promise(() => {}),
      collected: {},
      terminate() { calls.terminate += 1 },
      waitForExit(signal) {
        calls.waitForExit += 1
        if (options.rejectOnWait === true) return Promise.reject(new Error('失去观测能力'))
        if (options.releaseOnWait === true) return Promise.resolve(true)
        if (signal === undefined) return range
        // 真实 seam 会响应等待上限；不响应时 `stop` 就没有返回的机会。
        return Promise.race([
          range,
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('等待上限到了')), { once: true })
          }),
        ])
      },
    },
    releaseRange: () => releaseRange(true),
  }
}

/**
 * 造一条隧道，并记下句柄与状态序列。
 * @param options - 传给 {@link fakeHandle} 的选项。
 * @returns 隧道、句柄列表、状态序列，以及「等第 n 个句柄出现」。
 */
function harness(options = {}) {
  const handles = []
  const states = []
  const waiters = []
  const tunnel = new Tunnel({
    subprocess: {
      spawn() {
        const made = fakeHandle(options)
        handles.push(made)
        for (const wake of waiters.splice(0)) wake()
        return made.handle
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    cwd: '/tmp',
    relayPort: 18080,
    logLabel: 'test',
    backoffMs: [20],
    healthyAfterMs: 10,
    graceMs: 20,
    extraOptions: {},
    connectTimeoutSec: 5,
    knownHostsFile: '/tmp/known_hosts',
    identityFile: '/tmp/relay_key',
    dshPort: () => 3090,
    beforeConnect: async () => {},
    onState: (state) => { states.push(state) },
  })
  return {
    tunnel,
    handles,
    states,
    /** 等到第 `n` 个句柄出现；等不到就抛，避免测试挂住。 */
    async nth(n) {
      for (let i = 0; i < 200 && handles.length <= n; i += 1) {
        await new Promise((wake) => { waiters.push(wake); setTimeout(wake, 10) })
      }
      assert.ok(handles.length > n, `没有等到第 ${String(n)} 个连接`)
      return handles[n]
    },
  }
}

/** 等一小段真实时间，让循环推进。 */
function tick(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('stop 等进程范围空掉才返回', async (t) => {
  const h = harness()
  t.after(() => h.tunnel.stop())
  await h.tunnel.start(deployment())
  const first = await h.nth(0)

  let stopped = false
  const stopping = h.tunnel.stop().then(() => { stopped = true })

  await tick(30)
  assert.equal(first.calls.terminate, 1, '应当请求终止当前进程')
  assert.ok(first.calls.waitForExit >= 1, '应当等进程范围空掉')
  assert.equal(stopped, false, '进程范围没空之前 stop 不应返回')

  first.releaseRange()
  await stopping
  assert.equal(h.tunnel.state(), 'stopped')
})

test('done 永不落定时循环仍会离开 running', async (t) => {
  const h = harness()
  t.after(() => h.tunnel.stop())
  await h.tunnel.start(deployment())
  const first = await h.nth(0)
  await tick(30)
  assert.ok(h.states.includes('running'), '存活超过健康阈值后应报告 running')

  first.releaseRange()
  await tick(60)
  assert.ok(h.states.includes('backing-off'), '进程消失后不应停留在 running')
  await h.nth(1)
})

test('waitForExit 抛出时 stop 仍然返回', async (t) => {
  const h = harness({ rejectOnWait: true })
  t.after(() => h.tunnel.stop())
  await h.tunnel.start(deployment())
  await h.nth(0)
  await h.tunnel.stop()
  assert.equal(h.tunnel.state(), 'stopped')
})
