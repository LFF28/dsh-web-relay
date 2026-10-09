/**
 * 运行记录的输出契约。
 *
 * 最重要的一条是**白名单**：记录里有 `gateway.sessionSecret`，它是网关会话 Cookie
 * 的比对值。迁移前它有 schema 的 `role('secret')` 遮蔽兜底，迁移后这条路没有了，遮蔽
 * 完全由 `recordView` 的白名单承担。所以这里断言的是"密值不出现在视图里"，而不是
 * 某个具体字段名。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Record, recordView } from '../lib/record.js'

const SECRET = 'SECRET-DO-NOT-SHIP-0123456789'

/**
 * 一份填满的原始记录。
 * @returns 记录。
 */
function full() {
  return Record({
    state: 'ready',
    publicAuthority: '203.0.113.7:8443',
    observedHostKeyFingerprint: 'SHA256:abc',
    caFingerprint: 'AA:BB',
    caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    gateway: { sessionSecret: SECRET },
    steps: [{ id: '0', title: '本地工具检查', status: 'ok', detail: '都在' }],
    lastError: '',
    lastPreflight: { outcome: 'free', message: '' },
    tunnelState: 'running',
  })
}

test('视图里绝不出现网关会话密钥', () => {
  const view = recordView(full())
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes(SECRET), false, '会话密钥漏进了浏览器视图')
  assert.equal(serialized.includes('sessionSecret'), false, '会话密钥字段名漏进了浏览器视图')
  assert.equal(serialized.includes('gateway'), false, '整个 gateway 一节都不该出去')
})

test('视图保留状态区需要的全部字段', () => {
  const view = recordView(full())
  assert.deepEqual(Object.keys(view).sort(), [
    'caFingerprint', 'caPem', 'lastError', 'lastPreflight',
    'observedHostKeyFingerprint', 'publicAuthority', 'state', 'steps', 'tunnelState',
  ].sort())
  assert.equal(view.state, 'ready')
  assert.equal(view.tunnelState, 'running')
  assert.equal(view.publicAuthority, '203.0.113.7:8443')
})

test('根证书全文原样出去：页面要靠它存成本地文件', () => {
  const view = recordView(full())
  assert.equal(view.caPem, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
  assert.equal(view.caFingerprint, 'AA:BB')
})

test('记录缺省字段由 schema 补齐，视图不出现 undefined', () => {
  const view = recordView(Record({}))
  assert.equal(view.state, 'unconfigured')
  assert.equal(view.tunnelState, 'stopped')
  assert.deepEqual(view.steps, [])
  assert.equal(view.lastError, '')
  assert.equal(view.caPem, '')
  // `lastPreflight` 是唯一可缺省的一项：schema 给了默认值，所以它一定在。
  assert.deepEqual(view.lastPreflight, { outcome: 'free', message: '' })
})

test('手工改坏的记录节被 schema 拒绝，而不是悄悄放行', () => {
  assert.throws(() => Record({ state: 'not-a-state' }), /state/u)
  assert.throws(() => Record({ tunnelState: 'flying' }), /tunnelState/u)
})

test('步骤表必须是闭集：状态与必填字段都参与校验', () => {
  assert.throws(() => Record({ steps: [{ id: '0', title: 't', status: 'maybe', detail: 'd' }] }))
  assert.throws(() => Record({ steps: [{ id: '0' }] }))
})
