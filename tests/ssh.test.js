/**
 * `ssh` 参数构造与指纹解析。
 *
 * 这里守的是两件在真实故障里代价很高的事：远程命令被重新分词（模板片段里带空格
 * 时静默做错事），以及主机指纹解析错位（把别的密钥当成中继的）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminTarget, commandArgv, connectionArgv, controlPathFits, egressAddress, parseFingerprints, preferredFingerprint, shellQuote } from '../lib/ssh.js'

/** 一份连接身份。 */
const TARGET = {
  host: '175.178.171.191',
  port: 22,
  user: 'ubuntu',
  identityFile: undefined,
  knownHostsFile: '/home/me/.dsh-relay/ssh/known_hosts',
  connectTimeoutSec: 10,
  controlPath: undefined,
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

test('Compression 不在保护名单里，会真的落到 ssh 命令行上', () => {
  const argv = connectionArgv({ ...TARGET, extraOptions: { Compression: 'yes' } })
  assert.ok(argv.includes('Compression=yes'), `argv 里没有压缩开关：${argv.join(' ')}`)
})

test('管理连接永远不吃隧道专用的 extraOptions', () => {
  // 引导与预检走 adminTarget：给隧道开压缩不该顺手改掉管理动作的行为。
  const target = adminTarget({ host: 'h', sshPort: 22, user: 'root', identityFile: undefined, hostKeyFingerprint: undefined, gatewayPort: 8443, password: 'p', autoDeploy: false, authority: undefined, hostname: undefined }, '/tmp/kh', 10)
  const argv = connectionArgv(target)
  assert.ok(!argv.some(a => a.startsWith('Compression=')))
})

test('控制套接字只在给了 ControlPath 时才写进命令行', () => {
  // 不给就不复用：隧道走这条，它要自己独立管一条连接。
  const plain = connectionArgv(TARGET)
  assert.equal(plain.some(a => a.startsWith('ControlMaster=')), false)
  assert.equal(plain.some(a => a.startsWith('ControlPath=')), false)
  assert.equal(plain.some(a => a.startsWith('ControlPersist=')), false)

  const shared = connectionArgv({ ...TARGET, controlPath: '/root/ssh/cm/%C' })
  assert.ok(shared.includes('ControlMaster=auto'))
  assert.ok(shared.includes('ControlPath=/root/ssh/cm/%C'))
  assert.ok(shared.includes('ControlPersist=60'), '空闲 60 秒后 master 应自行退出')
})

test('ControlMaster 选项不能被 extraOptions 改掉', () => {
  // 这几项与 BatchMode 同级：被外部改掉会让复用行为（以及它的清理语义）失控。
  const argv = connectionArgv({
    ...TARGET,
    controlPath: '/root/ssh/cm/%C',
    extraOptions: { ControlPath: '/tmp/elsewhere', ControlMaster: 'no', ControlPersist: 'no' },
  })
  assert.ok(argv.includes('ControlPath=/root/ssh/cm/%C'), '插件自己的 ControlPath 被覆盖了')
  assert.ok(argv.includes('ControlMaster=auto'), '插件自己的 ControlMaster 被覆盖了')
  assert.ok(argv.includes('ControlPersist=60'), '插件自己的 ControlPersist 被覆盖了')
})

test('管理连接默认复用，且 %C 让不同账号分属不同套接字', () => {
  const row = {
    host: '175.178.171.191', sshPort: 22, user: 'ubuntu', identityFile: undefined,
    hostKeyFingerprint: undefined, gatewayPort: 8443, password: 'p', autoDeploy: false,
    authority: undefined, hostname: undefined,
  }
  const argv = connectionArgv(adminTarget(row, '/tmp/kh', 10))
  assert.ok(argv.some(a => a.startsWith('ControlPath=')), '管理连接应默认复用')
  assert.ok(argv.some(a => a.endsWith('/%C')), '%C 是账号隔离的依据，不能被换掉')
})

test('ControlPath 放不下时退回直连，而不是让所有连接一起失败', () => {
  // unix 套接字路径上限 108 字节，超了 ssh 在连上之前就拒绝启动。
  assert.equal(controlPathFits('/short/cm/%C'), true)
  assert.equal(controlPathFits(`/${'x'.repeat(120)}/%C`), false)
  // %C 必须按展开后的 40 字符算，否则长路径会被误判成放得下。
  // `/` + 66 个 x + `/%C` 展开后是 1+66+1+40 = 108，正好触到上限（108 已越界）。
  assert.equal(controlPathFits(`/${'x'.repeat(66)}/%C`), false)
  assert.equal(controlPathFits(`/${'x'.repeat(65)}/%C`), true, '107 字节应仍然放得下')
})

test('commandArgv 把远程命令收成单独一个参数', () => {
  const argv = commandArgv(TARGET, 'sudo -n true')
  assert.equal(argv.at(-1), 'sudo -n true')
  assert.equal(argv.filter(word => word === 'sudo -n true').length, 1)
})

test('egressAddress 只接受字面量地址', () => {
  assert.equal(egressAddress('183.48.247.66 52703 172.16.0.7 22'), '183.48.247.66')
  assert.equal(egressAddress('2001:db8::1 52703 172.16.0.7 22'), '2001:db8::1')
  // 取不到就返回 undefined，让 jail 退回默认规则，而不是填一个空值或猜的值。
  assert.equal(egressAddress(undefined), undefined)
  assert.equal(egressAddress(''), undefined)
  assert.equal(egressAddress('   '), undefined)
  // ignoreip 是按空白分词的列表，能溜进来的只该是地址本身。
  assert.equal(egressAddress('1.2.3.4\nbantime = 0'), '1.2.3.4')
  assert.equal(egressAddress('evil.example'), undefined)
  assert.equal(egressAddress('1.2.3.4 # 注释'), '1.2.3.4')
  assert.equal(egressAddress('#1.2.3.4'), undefined)
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
