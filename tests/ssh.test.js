/**
 * `ssh` 参数构造与指纹解析。
 *
 * 这里守的是两件在真实故障里代价很高的事：远程命令被重新分词（模板片段里带空格
 * 时静默做错事），以及主机指纹解析错位（把别的密钥当成中继的）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandArgv, connectionArgv, parseFingerprints, preferredFingerprint, shellQuote } from '../lib/ssh.js'

/** 一份连接身份。 */
const TARGET = {
  host: '175.178.171.191',
  port: 22,
  user: 'ubuntu',
  identityFile: undefined,
  knownHostsFile: '/home/me/.dsh-relay/ssh/known_hosts',
  connectTimeoutSec: 10,
  extraOptions: {},
}

test('shellQuote 收尾再重开单引号', () => {
  assert.equal(shellQuote('plain'), `'plain'`)
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote(''), `''`)
  assert.equal(shellQuote('a b'), `'a b'`)
})

test('connectionArgv 带上每一条安全选项', () => {
  const argv = connectionArgv(TARGET, ['-N'])
  assert.equal(argv[0], 'ssh')
  assert.equal(argv.at(-1), 'ubuntu@175.178.171.191')
  const joined = argv.join(' ')
  assert.match(joined, /-o BatchMode=yes/)
  assert.match(joined, /-o StrictHostKeyChecking=yes/)
  // 专用 known_hosts 让主机的信任面与用户的 ~/.ssh 完全分开；
  // StrictHostKeyChecking=yes 保证未知密钥直接失败而不是被静默接受。
  assert.match(joined, /-o UserKnownHostsFile=\/home\/me\/\.dsh-relay\/ssh\/known_hosts/)
  assert.match(joined, /-o NumberOfPasswordPrompts=0/)
  assert.match(joined, /-o LogLevel=ERROR/)
  assert.match(joined, /-o ConnectTimeout=10/)
  assert.match(joined, /-p 22 ubuntu@175\.178\.171\.191$/)
})

test('给了私钥就锁死身份，不再乱试别的密钥', () => {
  const argv = connectionArgv({ ...TARGET, identityFile: '/home/me/.dsh-relay/ssh/id_ed25519' })
  const joined = argv.join(' ')
  assert.match(joined, /-o IdentitiesOnly=yes/)
  assert.ok(argv.includes('-i'))
  // 转发相关的选项（ExitOnForwardFailure、ServerAliveInterval）由 tunnel 追加：
  // 只有那里知道自己在做转发。
  assert.ok(!connectionArgv(TARGET).join(' ').includes('ExitOnForwardFailure'))
})

test('连接身份里的私钥在写出来时经过引用', () => {
  const argv = connectionArgv({ ...TARGET, identityFile: '/home/me/.ssh/id relay' })
  assert.ok(argv.includes('/home/me/.ssh/id relay'), 'argv 里是原值，不是带引号的字符串')
  assert.ok(argv.includes('-i'))
})

test('extraOptions 不能覆盖插件自己的安全选项', () => {
  const argv = connectionArgv({
    ...TARGET,
    extraOptions: { StrictHostKeyChecking: 'no', ServerAliveInterval: '30' },
  })
  assert.ok(argv.includes('StrictHostKeyChecking=yes'))
  assert.ok(!argv.includes('StrictHostKeyChecking=no'), '用户提供的同名值被丢弃')
  assert.ok(argv.includes('ServerAliveInterval=30'), '不冲突的选项照常生效')
})

test('commandArgv 把远程命令收成单独一个参数', () => {
  const argv = commandArgv(TARGET, 'sudo -n true')
  assert.equal(argv.at(-1), 'sudo -n true')
  assert.equal(argv.filter(word => word === 'sudo -n true').length, 1)
})

test('parseFingerprints 只取带类型的主机行', () => {
  const output = [
    '# 175.178.171.191:22 SSH-2.0-OpenSSH_10.2p1',
    '256 SHA256:aaaabbbb 175.178.171.191 (ED25519)',
    '3072 SHA256:ccccdddd 175.178.171.191 (RSA)',
    '256 SHA256:eeeeffff 175.178.171.191 (ECDSA)',
    'garbage line without parentheses',
    '256 SHA256:nobits 175.178.171.191',
  ].join('\n')
  const fingerprints = parseFingerprints(output)
  assert.equal(fingerprints.length, 3)
  assert.deepEqual(fingerprints[0], { fingerprint: 'SHA256:aaaabbbb', type: 'ED25519' })
})

test('preferredFingerprint 优先 ED25519', () => {
  const fingerprints = [
    { fingerprint: 'SHA256:rsa', type: 'RSA' },
    { fingerprint: 'SHA256:ed', type: 'ED25519' },
    { fingerprint: 'SHA256:ecdsa', type: 'ECDSA' },
  ]
  assert.equal(preferredFingerprint(fingerprints)?.fingerprint, 'SHA256:ed')
  assert.equal(preferredFingerprint([fingerprints[0]])?.fingerprint, 'SHA256:rsa')
  assert.equal(preferredFingerprint([]), undefined)
})
