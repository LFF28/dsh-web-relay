/**
 * 权威规范化。
 *
 * 这一组断言的形状全部来自 DSH 自己的围栏：`canonicalAuthority` 与
 * `isBareAuthority` 是 `@deepseek-ai/dsh-client-connection` 里同名逻辑的复刻，
 * 两处一旦不一致，表现是「手机打开是 403」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalAuthority, canonicalHostname, isBareAuthority, publicAuthority,
} from '../lib/authority.js'

test('canonicalAuthority 补全被 WHATWG 默认掉的端口', () => {
  assert.equal(canonicalAuthority('example.com'), 'example.com')
  assert.equal(canonicalAuthority('example.com:8443'), 'example.com:8443')
  // `:443` 在 http: 解析下不是默认端口，因此它仍然是显式端口——`canonicalAuthority`
  // 两个 special scheme 都问一遍，正是为了不把它误抹掉。
  assert.equal(canonicalAuthority('example.com:443'), 'example.com:443')
  assert.equal(canonicalAuthority('127.0.0.1:8443'), '127.0.0.1:8443')
  assert.equal(canonicalAuthority('[::1]:8443'), '[::1]:8443')
  assert.equal(canonicalAuthority('not a host'), undefined)
})

test('isBareAuthority 只接受逐字等于规范形式的输入', () => {
  for (const good of ['example.com', 'example.com:8443', 'example.com:443', '1.2.3.4', '1.2.3.4:443', '[::1]:8443']) {
    assert.equal(isBareAuthority(good), true, good)
  }
  for (const bad of [
    'example.com:080', // 补零端口两种解析都可能读成 80
    'harness.internal/path',
    'user@harness.internal',
    ' example.com',
    'example.com ',
    'example.com:',
    '0x7f.0.0.1',
    '::1',
    'https://example.com',
    '',
  ]) {
    assert.equal(isBareAuthority(bad), false, JSON.stringify(bad))
  }
})

test('publicAuthority 让写在地址里的端口压过网关端口', () => {
  assert.equal(publicAuthority('1.2.3.4', 8443), '1.2.3.4:8443')
  assert.equal(publicAuthority('1.2.3.4:9443', 8443), '1.2.3.4:9443')
  assert.equal(publicAuthority('1.2.3.4:443', 8443), '1.2.3.4:443')
  assert.equal(publicAuthority('', 8443), undefined)
  assert.equal(publicAuthority('user@1.2.3.4', 8443), undefined)
})

test('canonicalHostname 给出不带端口的主机名', () => {
  assert.equal(canonicalHostname('1.2.3.4:8443'), '1.2.3.4')
  assert.equal(canonicalHostname('example.com'), 'example.com')
  assert.equal(canonicalHostname('https://example.com'), undefined)
})
