/**
 * 部署参数的规范化与写入校验。
 *
 * 规范化的输出是整个插件的分叉点：引导、隧道、预检、权威注册都拿它当输入，所以
 * 它必须把"留空"与"没这个键"收成同一种东西，并在地址形状非法时给出 `undefined`
 * 权威而不是猜一个。校验那一组钉住的是另一半：坏值在写入时就被拒，而不是存下来
 * 之后让围栏在运行期拒绝——后者的表现是"手机打开是 403"，用户手上没有任何线索。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateDeployment } from '../lib/config.js'
import { isRunnable, normalize } from '../lib/deployment.js'

/** 造一份设置里的原始参数。 */
function raw(overrides = {}) {
  return {
    vps: { host: '', port: 22, user: 'root', identityFile: '', hostKeyFingerprint: '' },
    gateway: { port: 8443, password: '' },
    tunnel: { autoStart: true },
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

test('validateDeployment 放行尚未配置的空地址', () => {
  // 全新安装的文档里什么都没有，注册与启动都要经过这次 resolve。
  validateDeployment(raw())
})

test('validateDeployment 在填了地址却没有口令时拒绝', () => {
  assert.throws(
    () => { validateDeployment(raw({ vps: { host: '1.2.3.4' } })) },
    /gateway\.password 不能为空/u,
  )
})

test('validateDeployment 在地址形状非法时拒绝', () => {
  assert.throws(
    () => { validateDeployment(raw({ vps: { host: 'https://1.2.3.4/' }, gateway: { password: 'p' } })) },
    /vps\.host 必须是裸的/u,
  )
})
