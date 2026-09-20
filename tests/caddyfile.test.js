/**
 * Caddyfile 模板的渲染与那两条"带路"规则。
 *
 * 断言的是关系而不是模板快照：改写与跳转的目标必须等于插件注册的换票点路径，改写
 * 的判据里必须有"没有 DSH 会话 Cookie"，恢复跳转的判据必须写在 `handle_response`
 * 块内（它自己的匹配器是响应匹配器，那里的 `header` 看的是响应头）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderCaddyfile } from '../lib/bootstrap.js'
import { ENTER_PATH } from '../lib/entry.js'
import { readTemplate } from '../lib/templates.js'

const template = await readTemplate('Caddyfile.snippet')

/**
 * 用一份完整取值渲染模板。
 * @returns Caddyfile 正文。
 */
function render() {
  return renderCaddyfile(template, {
    authority: '203.0.113.7:8443',
    hostname: '203.0.113.7',
    gatewayPort: 8443,
    relayPort: 18080,
    sessionSecret: 'session-secret',
    passwordHash: '$2a$14$abcdefghijklmnopqrstuv',
  })
}

/**
 * 渲染结果里 `rewrite <匹配器> <目标>` 的全部目标。
 * @param text - Caddyfile 正文。
 * @returns 目标路径列表。
 */
function rewriteTargets(text) {
  return [...text.matchAll(/^[ \t]*rewrite \S+ (\S+)$/gmu)].map(match => match[1])
}

/**
 * 渲染结果里 `redir <目标> <状态码>` 的全部目标。
 * @param text - Caddyfile 正文。
 * @returns 目标路径列表。
 */
function redirectTargets(text) {
  return [...text.matchAll(/^[ \t]*redir \S+ (\S+) \d+$/gmu)].map(match => match[1])
}

test('没带会话 Cookie 的文档导航被内部改写到换票点', () => {
  assert.deepEqual(rewriteTargets(render()), [ENTER_PATH])
})

test('失效 Cookie 的 401 也回到换票点', () => {
  assert.deepEqual(redirectTargets(render()), [ENTER_PATH])
})

test('改写判据里有"没有 DSH 会话 Cookie"，否则每次取界面都会再换一次票', () => {
  const guard = /@noDsh \{\n([\s\S]*?)\n\t\}/u.exec(render())?.[1] ?? ''
  assert.match(guard, /not header Cookie \*dsh-auth-\*/u)
  assert.match(guard, /header Accept \*text\/html\*/u)
})

test('恢复跳转的判据写在 handle_response 块内，其余 401 原样透传', () => {
  const text = render()
  assert.equal((/@unauth ([^\n{]*)/u.exec(text)?.[1] ?? '').trim(), 'status 401')
  const block = /handle_response @unauth \{\n([\s\S]*?)\n\t\t\}/u.exec(text)?.[1] ?? ''
  assert.match(block, /method GET/u)
  assert.match(block, /header Accept \*text\/html\*/u)
  assert.match(block, /redir @doc \/relay\/enter 302/u)
  assert.match(block, /copy_response/u)
})

test('模板占位符全部填完', () => {
  assert.doesNotMatch(render(), /@@[A-Z0-9_]+@@/u)
})
