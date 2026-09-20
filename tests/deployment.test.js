/**
 * 部署参数的规范化与差异判定。
 *
 * 「改口令」与「改地址」必须被区分开：前者要重算 bcrypt、换会话密钥、重写
 * Caddyfile，后者只需要让围栏重解析。这一组把两个方向的判定都钉住。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diff, isRunnable, needsBootstrap, needsTunnelRestart, normalize } from '../lib/deployment.js'

/** 造一份设置里的原始参数。 */
function raw(overrides = {}) {
  return {
    vps: { host: '', port: 22, user: 'root', identityFile: '', hostKeyFingerprint: '' },
    gateway: { port: 8443, password: '' },
    tunnel: { autoStart: true },
    bootstrapRequest: 0,
    ...overrides,
  }
}

test('normalize 把留空的字段收成 undefined，并推出权威', () => {
  const deployment = normalize(raw({ vps: { host: '1.2.3.4', user: 'ubuntu' }, gateway: { password: 'p' } }))
  assert.equal(deployment.authority, '1.2.3.4:8443')
  assert.equal(deployment.hostname, '1.2.3.4')
  assert.equal(deployment.identityFile, undefined)
  assert.equal(deployment.hostKeyFingerprint, undefined)
})

test('normalize 对非法的 vps.host 给出 undefined 权威而不是猜一个', () => {
  const deployment = normalize(raw({ vps: { host: 'user@1.2.3.4' }, gateway: { password: 'p' } }))
  assert.equal(deployment.authority, undefined)
  assert.equal(deployment.hostname, undefined)
})

test('isRunnable 只要求地址与口令', () => {
  assert.equal(isRunnable(normalize(raw())), false)
  assert.equal(isRunnable(normalize(raw({ vps: { host: '1.2.3.4' } }))), false)
  assert.equal(isRunnable(normalize(raw({ gateway: { password: 'p' } }))), false)
  assert.equal(isRunnable(normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'p' } }))), true)
})

test('首次对账不要求引导', () => {
  const change = diff(undefined, normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'p' } })))
  assert.equal(needsBootstrap(change), false)
  assert.equal(change.authority, true)
})

test('改地址要重新引导新主机，改口令不碰隧道', () => {
  const before = normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'p' } }))
  const address = diff(before, normalize(raw({ vps: { host: '1.2.3.5' }, gateway: { password: 'p' } })))
  assert.equal(address.authority, true)
  assert.equal(address.adminIdentity, true)
  assert.equal(address.password, false)
  // 新地址上还没有任何东西，必须先引导。
  assert.equal(needsBootstrap(address), true)
  assert.equal(needsTunnelRestart(address), true)

  const password = diff(before, normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'q' } })))
  assert.equal(password.authority, false)
  assert.equal(password.adminIdentity, false)
  assert.equal(password.password, true)
  assert.equal(needsBootstrap(password), true)
  // 隧道用的是受限账号与专用私钥，与网关口令无关。
  assert.equal(needsTunnelRestart(password), false)
})

test('改管理身份或主机指纹要求重跑引导', () => {
  const before = normalize(raw({ vps: { host: '1.2.3.4', user: 'ubuntu' }, gateway: { password: 'p' } }))
  const user = diff(before, normalize(raw({ vps: { host: '1.2.3.4', user: 'root' }, gateway: { password: 'p' } })))
  assert.equal(user.adminIdentity, true)
  assert.equal(needsBootstrap(user), true)

  const fingerprint = diff(before, normalize(raw({
    vps: { host: '1.2.3.4', user: 'ubuntu', hostKeyFingerprint: 'SHA256:abc' },
    gateway: { password: 'p' },
  })))
  assert.equal(fingerprint.hostKey, true)
  // 指纹变了就得让下一次引导重新比对一次，否则用户永远等不到那声拒绝。
  assert.equal(needsBootstrap(fingerprint), true)
})

test('重新引导计数变化要求重跑引导', () => {
  const before = normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'p' } }))
  const change = diff(before, normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'p' }, bootstrapRequest: 1 })))
  assert.equal(change.bootstrap, true)
  assert.equal(needsBootstrap(change), true)
})

test('只有换地方或换身份才重连隧道', () => {
  const before = normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'p' } }))
  const after = normalize(raw({ vps: { host: '1.2.3.5' }, gateway: { password: 'p' } }))
  assert.equal(needsTunnelRestart(diff(before, after)), true)
  assert.equal(needsTunnelRestart(diff(before, before)), false)

  const silent = normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'p' }, bootstrapRequest: 3 }))
  assert.equal(needsTunnelRestart(diff(before, silent)), false)

  // 自动拉起开关由对账自己处理（开就起、关就停），不走「重连」这条路。
  const off = normalize(raw({ vps: { host: '1.2.3.4' }, gateway: { password: 'p' }, tunnel: { autoStart: false } }))
  assert.equal(needsTunnelRestart(diff(before, off)), false)
  assert.equal(diff(before, off).autoStart, true)
})
