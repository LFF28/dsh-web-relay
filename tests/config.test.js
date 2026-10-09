/**
 * 插件配置的 schema：包内旋钮 + volatile 的部署子树。
 *
 * 这里断言的是两件在 0.2 迁移里最容易悄悄坏掉的事：
 *
 * - `deployment` 必须是**一个** volatile 引用（整棵子树标 volatile），而不是散落的
 *   若干标量字段。`SettingsForms.write` 只接受 volatile 路径，标错了设置页就写不进去。
 * - 配置里的普通字段（`logLabel`、`tunnel`）不能被 volatile 一起带走：它们是随包发布
 *   的旋钮，改它们要重挂载。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, Deployment, resolveRelayConfig, validateDeployment } from '../lib/config.js'

test('deployment 整棵子树是一个 volatile 引用', () => {
  const parsed = Config({})
  assert.equal(typeof parsed.deployment.get, 'function')
  const value = parsed.deployment.get()
  // 缺省值由 Deployment schema 补齐，所以下游拿到的一定是全的。
  assert.equal(value.vps.host, '')
  assert.equal(value.vps.port, 22)
  assert.equal(value.gateway.port, 8443)
  assert.equal(value.deploy.autoDeploy, false)
})

test('包内旋钮留在普通字段上，没被 volatile 带走', () => {
  const parsed = Config({})
  assert.equal(parsed.logLabel, 'dsh-web-relay')
  assert.equal(typeof parsed.tunnel.extraOptions, 'object')
  assert.equal(typeof parsed.tunnel.extraOptions.get, 'undefined')
})

test('写进 deployment 的值原样成为 volatile 引用的内容', () => {
  const parsed = Config({
    deployment: {
      vps: { host: '203.0.113.7', user: 'ubuntu' },
      gateway: { port: 9443, password: 'pw' },
      deploy: { autoDeploy: true },
    },
  })
  const value = parsed.deployment.get()
  assert.equal(value.vps.host, '203.0.113.7')
  assert.equal(value.vps.user, 'ubuntu')
  assert.equal(value.gateway.port, 9443)
  assert.equal(value.gateway.password, 'pw')
  assert.equal(value.deploy.autoDeploy, true)
})

test('tunnel.extraOptions 能把 Compression 带给 ssh', () => {
  const parsed = Config({ tunnel: { extraOptions: { Compression: 'yes' } } })
  assert.deepEqual(parsed.tunnel.extraOptions, { Compression: 'yes' })
  assert.equal(resolveRelayConfig(parsed).extraOptions.Compression, 'yes')
})

test('resolveRelayConfig 在手工搭的空配置上也补齐全部字段', () => {
  const resolved = resolveRelayConfig(undefined)
  assert.equal(resolved.logLabel, 'dsh-web-relay')
  assert.equal(resolved.relayPort, 18080)
  assert.equal(resolved.entryEnabled, true)
  assert.equal(resolved.publicProbe, true)
  assert.deepEqual(resolved.extraOptions, {})
})

test('validateDeployment 接受空的与合法的地址', () => {
  assert.doesNotThrow(() => { validateDeployment(Deployment({})) })
  assert.doesNotThrow(() => {
    validateDeployment(Deployment({ vps: { host: '203.0.113.7' }, gateway: { password: 'pw' } }))
  })
  assert.doesNotThrow(() => {
    validateDeployment(Deployment({ vps: { host: 'relay.example.com:8443' }, gateway: { password: 'pw' } }))
  })
})

test('validateDeployment 拒绝带 scheme/路径/空白的地址', () => {
  for (const host of ['https://203.0.113.7', '203.0.113.7/x', ' 203.0.113.7', 'user@203.0.113.7']) {
    assert.throws(
      () => { validateDeployment(Deployment({ vps: { host }, gateway: { password: 'pw' } })) },
      /vps\.host/u,
      `应当拒绝 ${JSON.stringify(host)}`,
    )
  }
})

test('validateDeployment 拒绝填了地址却没有口令', () => {
  assert.throws(
    () => { validateDeployment(Deployment({ vps: { host: '203.0.113.7' } })) },
    /gateway\.password/u,
  )
})

test('vps.host 与 gateway.password 都是 role(secret) 之外的可读字段', () => {
  // 口令是 role('secret')，但它在 schema 里仍然存在——遮蔽发生在出网边界，不在解析。
  const parsed = Config({ deployment: { gateway: { password: 'pw' } } })
  assert.equal(parsed.deployment.get().gateway.password, 'pw')
})
