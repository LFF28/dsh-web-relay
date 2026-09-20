/**
 * 托管块脚本。
 *
 * 这一组把生成的脚本真的交给 `sh` 跑，而不是只比对字符串：脚本里同时有
 * 「滤掉旧块」「按位置拼装」「原子替换」「回读比对」「校验失败回滚」五件事，
 * 字符串断言看不出它们有没有一起成立。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { extractManagedBlock, managedBlockScript, substitute } from '../lib/templates.js'

const run = promisify(execFile)

/** 造一个临时目录，测试结束就删掉。 */
async function withDir(body) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-relay-test-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 执行一段生成出来的脚本。
 * @returns 退出码与 stderr。
 */
async function runScript(dir, script) {
  const path = join(dir, 'generated.sh')
  await writeFile(path, script)
  try {
    const { stderr } = await run('sh', [path])
    return { code: 0, stderr }
  } catch (error) {
    return { code: error.code, stderr: error.stderr }
  }
}

const BLOCK = '# BEGIN dsh-web-relay\nblock line one\n# END dsh-web-relay\n'

test('extractManagedBlock 只取标记之间的内容', () => {
  const text = `# 说明\n# 说明二\n${BLOCK}`
  assert.equal(extractManagedBlock(text), '# BEGIN dsh-web-relay\nblock line one\n# END dsh-web-relay')
  assert.throws(() => extractManagedBlock('# BEGIN dsh-web-relay\nno end\n'), /标记/)
})

test('substitute 替换全部占位符并拒绝漏项', () => {
  assert.equal(substitute('a @@X@@ b @@X@@', { X: '1' }), 'a 1 b 1')
  assert.throws(() => substitute('a @@X@@', {}), /@@X@@/)
})

test('属主与属组写进 install 参数，只给属主时属组跟随', () => {
  const withOwner = managedBlockScript({ path: '/x', mode: 0o640, owner: 'root', group: 'caddy' }, BLOCK)
  assert.match(withOwner, /install -m 0640 -o 'root' -g 'caddy' "\$work\/next" "\$target"/)
  const ownerOnly = managedBlockScript({ path: '/x', mode: 0o600, owner: 'root' }, BLOCK)
  assert.match(ownerOnly, /install -m 0600 -o 'root' -g 'root' "\$work\/next" "\$target"/)
  const anonymous = managedBlockScript({ path: '/x', mode: 0o644 }, BLOCK)
  assert.match(anonymous, /install -m 0644 "\$work\/next" "\$target"/)
})

test('托管块追加在末尾，块外内容原样保留', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'authorized_keys')
    await writeFile(target, 'user key\n')
    const result = await runScript(dir, managedBlockScript({ path: target, mode: 0o600 }, BLOCK))
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(target, 'utf8'), `user key\n${BLOCK}`)
  })
})

test('托管块写进最前面，既有站点留在后面', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'Caddyfile')
    await writeFile(target, ':80 {\n\troot * /var/www\n}\n')
    const script = managedBlockScript({ path: target, mode: 0o644, position: 'top' }, BLOCK)
    const result = await runScript(dir, script)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(target, 'utf8'), `${BLOCK}:80 {\n\troot * /var/www\n}\n`)
  })
})

test('重复执行只留一个块，且块外内容不累积', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'authorized_keys')
    await writeFile(target, 'user key\n# BEGIN dsh-web-relay\nold\n# END dsh-web-relay\n')
    const script = managedBlockScript({ path: target, mode: 0o600 }, BLOCK)
    assert.equal((await runScript(dir, script)).code, 0)
    assert.equal((await runScript(dir, script)).code, 0)
    assert.equal(await readFile(target, 'utf8'), `user key\n${BLOCK}`)
  })
})

test('校验不通过时恢复安装前的内容，并以退出码 5 结束', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'sshd_config')
    await writeFile(target, 'original\n')
    const script = managedBlockScript({ path: target, mode: 0o600, guard: 'false' }, BLOCK)
    const result = await runScript(dir, script)
    assert.equal(result.code, 5, result.stderr)
    assert.equal(await readFile(target, 'utf8'), 'original\n')
  })
})

test('校验不通过且此前没有这个文件时把它删掉', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'sshd_config')
    const script = managedBlockScript({ path: target, mode: 0o600, guard: 'false' }, BLOCK)
    assert.equal((await runScript(dir, script)).code, 5)
    await assert.rejects(() => readFile(target, 'utf8'))
  })
})

test('校验通过时保留新内容', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'sshd_config')
    await writeFile(target, 'original\n')
    const script = managedBlockScript({ path: target, mode: 0o600, guard: 'true' }, BLOCK)
    assert.equal((await runScript(dir, script)).code, 0)
    assert.equal(await readFile(target, 'utf8'), `original\n${BLOCK}`)
  })
})

test('目标原本没有结尾换行时补一个，块不会和上一行粘在一起', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'authorized_keys')
    await writeFile(target, 'user key')
    const script = managedBlockScript({ path: target, mode: 0o600 }, BLOCK)
    assert.equal((await runScript(dir, script)).code, 0)
    assert.equal(await readFile(target, 'utf8'), `user key\n${BLOCK}`)
  })
})

test('目标是目录下的新路径时同样成立', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'nested', 'missing', 'file')
    const script = managedBlockScript({ path: target, mode: 0o600 }, BLOCK)
    // 目录不存在时 install 会失败——这一步不该被悄悄跳过。
    assert.notEqual((await runScript(dir, script)).code, 0)
  })
})
