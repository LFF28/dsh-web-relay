/**
 * 引导：用管理账号把中继主机配置成一台可用的入口。
 *
 * 覆盖 `docs/modules/bootstrap.md` 的第 0–10 步——从本机工具检查到取回 CA 根证书。
 * 第 11–13 步（注册权威、拉起隧道、公网自检）牵涉 DSH 运行期与权威，归
 * `service.ts` 编排，但共用这里定义的步骤目录与 {@link StepLog}。
 *
 * 每一步都是「可以重跑」的：判据是既成事实（文件在不在、命令能不能找到），不是
 * 游标。所以"重新引导"就是把整串从头再跑一遍。
 * @module dsh-web-relay/bootstrap
 */

import { access, constants, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { BootstrapStep } from './config.js'
import type { Deployment } from './deployment.js'
import { commandArgv, egressAddress, firstLine, parseFingerprints, preferredFingerprint, runSsh, shellQuote, type HostKeyFingerprint, type SshRunResult, type SshTarget } from './ssh.js'
import { managedBlockScript, readTemplate, substitute, wholeFileScript, type ManagedFile } from './templates.js'
import type { RelayLogger } from './tunnel.js'

/** 全部 14 步的编号与标题，与 `docs/modules/bootstrap.md` 的表格逐行对应。 */
export const STEP_TITLES: ReadonlyArray<readonly [string, string]> = [
  ['0', '本地工具检查'],
  ['1', '生成中继密钥对'],
  ['2', '固定中继主机密钥'],
  ['3', '管理连接与能力探测'],
  ['4', '创建受限账号 relay'],
  ['5', '写 authorized_keys 托管块'],
  ['6', '写 sshd 片段并校验重载'],
  ['7', '安装 Caddy 与 fail2ban'],
  ['8', '计算网关口令哈希'],
  ['9', '写 Caddyfile 并校验重载'],
  ['10', '取回 CA 根证书'],
  ['11', '注册权威并自检'],
  ['12', '拉起隧道'],
  ['13', '公网自检并输出访问地址'],
]

/** 记录本次引导每一步的结果。 */
export class StepLog {
  readonly #steps: BootstrapStep[] = []

  /** 已记录的步骤，按发生顺序。 */
  get steps(): readonly BootstrapStep[] {
    return this.#steps
  }

  /**
   * 记一步。
   * @param id - 步骤编号。
   * @param status - 结果。
   * @param detail - 一句话说明。
   */
  add(id: string, status: BootstrapStep['status'], detail: string): void {
    const title = STEP_TITLES.find(([stepId]) => stepId === id)?.[1] ?? id
    const existing = this.#steps.findIndex(step => step.id === id)
    const step: BootstrapStep = { id, title, status, detail }
    if (existing === -1) this.#steps.push(step)
    else this.#steps[existing] = step
  }

  /**
   * 把某个编号之后的全部步骤标成未执行。
   * @param afterId - 最后一个已记录的步骤编号。
   * @param reason - 未执行的原因。
   */
  skipAfter(afterId: string, reason: string): void {
    const index = STEP_TITLES.findIndex(([id]) => id === afterId)
    for (const [id] of STEP_TITLES.slice(index + 1)) {
      if (this.#steps.some(step => step.id === id)) continue
      this.add(id, 'skipped', reason)
    }
  }
}

/** 探测到的中继环境事实。 */
export interface RemoteEnvironment {
  /** `id -u`。 */
  readonly uid: string
  /** `/etc/os-release` 的 `ID`。 */
  readonly osId: string
  /** `/etc/os-release` 的 `VERSION_ID`。 */
  readonly osVersion: string
  /** 管理命令是否必须穿过 `sudo -n`。 */
  readonly useSudo: boolean
  /** `ss` 是否可用（转发前预检需要它）。 */
  readonly hasSs: boolean
  /** `apt-get` 是否可用。 */
  readonly hasApt: boolean
  /** `/etc/ssh/sshd_config` 是否 `Include` 了 `sshd_config.d/*.conf`。 */
  readonly sshdInclude: boolean
  /** `sshd` 的 systemd 单元名（`ssh` 或 `sshd`）。 */
  readonly sshdUnit: string
  /** `systemctl` 是否可用。 */
  readonly hasSystemctl: boolean
}

/** 引导 0–10 步的结果。 */
export interface BootstrapOutcome {
  /** 是否全部通过。 */
  readonly ok: boolean
  /** 失败时的原文摘要。 */
  readonly error?: string
  /** 第 3 步探测到的环境；未走到时为 undefined。 */
  readonly environment?: RemoteEnvironment
  /** 第 10 步取回的根证书指纹。 */
  readonly caFingerprint: string
  /** 第 2 步观察到（或核对通过）的中继主机公钥指纹。 */
  readonly hostKeyFingerprint: string
  /** 第 7 步实际安装到的 Caddy 版本，用于记录。 */
  readonly caddyVersion: string
}

/** 引导的依赖与固定路径。 */
export interface BootstrapDeps {
  /** DSH 的子进程 seam。 */
  readonly subprocess: SubprocessRuntime
  /** 日志。 */
  readonly logger: RelayLogger
  /** 日志前缀。 */
  readonly logLabel: string
  /** 本机工作目录（密钥与 CA 就在它下面）。 */
  readonly cwd: string
  /** 本机专用 `known_hosts`。 */
  readonly knownHostsFile: string
  /** 中继私钥路径。 */
  readonly privateKeyPath: string
  /** 中继公钥路径。 */
  readonly publicKeyPath: string
  /** 本机保存 CA 根证书的位置。 */
  readonly caCertPath: string
  /** 中继上的反向转发端点端口。 */
  readonly relayPort: number
  /** 连接超时秒数。 */
  readonly connectTimeoutSec: number
  /** 单条远程命令的超时。 */
  readonly commandTimeoutMs: number
  /** 单个步骤（含 `apt` 安装）的总超时。 */
  readonly stepTimeoutMs: number
  /** 拆除宽限。 */
  readonly graceMs: number
  /** 网关会话 Cookie 的比对值，写进 Caddyfile。取值器：口令变化时会换一份。 */
  readonly sessionSecret: () => string
}

/**
 * 填 `deploy/Caddyfile.snippet` 需要的全部值。
 *
 * 入口开关不在其中：改写与跳转都由中继无条件执行，`entry.enabled` 只决定
 * `/relay/enter` 答什么（见 `entry.ts`）。路径不存在时浏览器会在 401 与 302 之间
 * 来回，那种失败比"入口关掉了"难查得多。
 */
export interface CaddyfileInputs {
  /** 公网权威。 */
  readonly authority: string
  /** 权威里不带端口的主机名，给 `default_sni` 用。 */
  readonly hostname: string
  /** 公网入口 HTTPS 端口。 */
  readonly gatewayPort: number
  /** 中继上的反向转发端点端口。 */
  readonly relayPort: number
  /** 网关会话 Cookie 的比对值。 */
  readonly sessionSecret: string
  /** 网关口令的 bcrypt 哈希。 */
  readonly passwordHash: string
}

/**
 * 填 `deploy/Caddyfile.snippet` 的占位符。
 * @param template - 模板原文。
 * @param inputs - 值。
 * @returns Caddyfile 正文。
 */
export function renderCaddyfile(template: string, inputs: CaddyfileInputs): string {
  return substitute(template, {
    AUTHORITY: inputs.authority,
    HOST: inputs.hostname,
    GATEWAY_PORT: String(inputs.gatewayPort),
    SESSION_SECRET: inputs.sessionSecret,
    BCRYPT_HASH: inputs.passwordHash,
    RELAY_PORT: String(inputs.relayPort),
  })
}

/** 一步失败时抛出，携带给用户看的原文。 */
class StepFailure extends Error {}

/** 引导主流程。 */
export class Bootstrap {
  /** 本机工具路径，第 0 步填上。 */
  #tools: Record<string, string> = {}
  /** 第 3 步的环境事实。 */
  #env: RemoteEnvironment | undefined
  /** 第 3 步取到的内网主机公网出口地址；留给第 9 步的 fail2ban `ignoreip`。 */
  #egressAddress: string | undefined
  /** 第 7 步观察到的 Caddy 版本。 */
  #caddyVersion = ''
  /** 第 2 步观察到的中继主机公钥指纹。 */
  #hostKeyFingerprint = ''

  /**
   * @param deps - 依赖。
   */
  constructor(private readonly deps: BootstrapDeps) {}

  /**
   * 跑第 0–10 步。
   * @param deployment - 部署参数。
   * @param log - 步骤记录器。
   * @param signal - 取消信号。
   * @returns 结果；失败时 `ok` 为 false 并带原文摘要。
   */
  async run(deployment: Deployment, log: StepLog, signal: AbortSignal): Promise<BootstrapOutcome> {
    let caFingerprint = ''
    this.#hostKeyFingerprint = ''
    try {
      await this.#stepLocalTools(log)
      await this.#stepKeypair(log)
      await this.#stepHostKey(deployment, log)
      await this.#stepProbe(deployment, log, signal)
      await this.#stepRelayUser(deployment, log, signal)
      await this.#stepAuthorizedKeys(deployment, log, signal)
      await this.#stepSshd(deployment, log, signal)
      await this.#stepPackages(deployment, log, signal)
      const hash = await this.#stepGatewayHash(deployment, log, signal)
      await this.#stepCaddyfile(deployment, log, signal, hash)
      caFingerprint = await this.#stepCaCert(deployment, log, signal)
      log.skipAfter('10', '等待后续步骤')
      return {
        ok: true,
        environment: this.#env,
        caFingerprint,
        hostKeyFingerprint: this.#hostKeyFingerprint,
        caddyVersion: this.#caddyVersion,
      }
    } catch (error) {
      const message = error instanceof StepFailure ? error.message : describeError(error)
      log.skipAfter(lastRecorded(log), message)
      return {
        ok: false,
        error: message,
        environment: this.#env,
        caFingerprint,
        hostKeyFingerprint: this.#hostKeyFingerprint,
        caddyVersion: this.#caddyVersion,
      }
    }
  }

  /** 第 0 步：本机要有 `ssh`、`ssh-keygen`、`ssh-keyscan`、`openssl`。 */
  async #stepLocalTools(log: StepLog): Promise<void> {
    const wanted = ['ssh', 'ssh-keygen', 'ssh-keyscan', 'openssl']
    const missing: string[] = []
    for (const tool of wanted) {
      const found = await localTool(tool)
      if (found === undefined) missing.push(tool)
      else this.#tools[tool] = found
    }
    if (missing.length > 0) {
      const detail = `本机缺少 ${missing.join('、')}`
      log.add('0', 'failed', detail)
      throw new StepFailure(detail)
    }
    log.add('0', 'ok', `${wanted.join('、')} 均在 PATH 上`)
  }

  /** 第 1 步：中继密钥对。私钥已存在就只补齐公钥。 */
  async #stepKeypair(log: StepLog): Promise<void> {
    const privateKey = this.deps.privateKeyPath
    const publicKey = this.deps.publicKeyPath
    if (await exists(privateKey)) {
      if (!await exists(publicKey)) {
        const derived = await runLocal(this.deps, [this.#tool('ssh-keygen'), '-y', '-f', privateKey])
        if (derived.exitCode !== 0) {
          const detail = `私钥在但公钥缺失，且无法从私钥导出：${firstLine(derived.stderr)}`
          log.add('1', 'failed', detail)
          throw new StepFailure(detail)
        }
        await writeFile(publicKey, `${derived.stdout.trim()} dsh-web-relay\n`, { mode: 0o644 })
      }
      await chmod(privateKey, 0o600)
      log.add('1', 'ok', '已有中继密钥对，沿用（公钥已与私钥核对）')
      return
    }
    await mkdir(dirname(privateKey), { recursive: true, mode: 0o700 })
    const created = await runLocal(this.deps, [
      this.#tool('ssh-keygen'), '-t', 'ed25519', '-N', '', '-C', 'dsh-web-relay', '-f', privateKey,
    ])
    if (created.exitCode !== 0) {
      const detail = `ssh-keygen 失败：${firstLine(created.stderr)}`
      log.add('1', 'failed', detail)
      throw new StepFailure(detail)
    }
    await chmod(privateKey, 0o600)
    log.add('1', 'ok', `已生成 ed25519 密钥对：${privateKey}`)
  }

  /** 第 2 步：把中继主机密钥钉进本机专用 `known_hosts`。 */
  async #stepHostKey(deployment: Deployment, log: StepLog): Promise<void> {
    const knownHosts = this.deps.knownHostsFile
    await mkdir(dirname(knownHosts), { recursive: true, mode: 0o700 })
    let fingerprints
    if (await exists(knownHosts) && (await readFile(knownHosts, 'utf8')).trim() !== '') {
      fingerprints = await this.#fingerprintsOf(knownHosts)
    } else {
      const scan = await runLocal(this.deps, [
        this.#tool('ssh-keyscan'), '-p', String(deployment.sshPort),
        '-t', 'ed25519,rsa,ecdsa', deployment.host,
      ], 30000)
      if (scan.exitCode !== 0 || scan.stdout.trim() === '') {
        const detail = `ssh-keyscan ${deployment.host}:${String(deployment.sshPort)} 没有拿到主机密钥：${firstLine(scan.stderr)}`
        log.add('2', 'failed', detail)
        throw new StepFailure(detail)
      }
      const staged = `${knownHosts}.staged`
      await writeFile(staged, scan.stdout, { mode: 0o600 })
      await rename(staged, knownHosts)
      fingerprints = await this.#fingerprintsOf(knownHosts)
    }
    const chosen = preferredFingerprint(fingerprints)
    if (chosen === undefined) {
      const detail = `${knownHosts} 里读不到任何主机密钥指纹`
      log.add('2', 'failed', detail)
      throw new StepFailure(detail)
    }
    const all = fingerprints.map(item => item.fingerprint)
    const expected = deployment.hostKeyFingerprint
    if (expected !== undefined && !all.some(value => value.toLowerCase() === expected.toLowerCase())) {
      const detail = `主机密钥指纹不符：设置里是 ${expected}，中继上是 ${all.join('、')}`
      log.add('2', 'failed', detail)
      throw new StepFailure(detail)
    }
    this.#hostKeyFingerprint = chosen.fingerprint
    log.add('2', 'ok', expected === undefined
      ? `TOFU 接受中继主机密钥 ${chosen.type} ${chosen.fingerprint}（请在记录里核对一次）`
      : `中继主机密钥 ${chosen.type} ${chosen.fingerprint} 与设置中的期望值一致`)
    this.deps.logger.info('%s 中继主机密钥指纹（%s）：%s', this.deps.logLabel, chosen.type, chosen.fingerprint)
  }

  /** 第 3 步：连上去，读环境事实。这一步是"插件不配置管理登录"的兑现方式。 */
  async #stepProbe(deployment: Deployment, log: StepLog, signal: AbortSignal): Promise<void> {
    const result = await this.#remote(deployment, PROBE_SCRIPT, { signal })
    if (result.exitCode !== 0) {
      const detail = `无法用 ${deployment.user}@${deployment.host} 登录或执行探测：${firstLine(result.stderr) || `退出码 ${String(result.exitCode)}`}`
      log.add('3', 'failed', detail)
      throw new StepFailure(detail)
    }
    const facts = parseKeyValues(result.stdout)
    const uid = facts['UID'] ?? ''
    const hasSs = facts['HAS_SS'] === '1'
    const useSudo = uid !== '0'
    this.#egressAddress = egressAddress(facts['EGRESS'])
    const env: RemoteEnvironment = {
      uid,
      osId: facts['OS_ID'] ?? '',
      osVersion: facts['OS_VERSION'] ?? '',
      useSudo,
      hasSs,
      hasApt: facts['HAS_APT'] === '1',
      sshdInclude: facts['SSHD_INCLUDE'] === '1',
      sshdUnit: facts['SSHD_UNIT'] ?? '',
      hasSystemctl: facts['HAS_SYSTEMCTL'] === '1',
    }
    this.#env = env
    if (useSudo && facts['SUDO'] !== 'ok') {
      const detail = `管理账号 ${deployment.user} 不是 root，且 sudo 不能免密执行（${facts['SUDO'] ?? '未知'}）`
      log.add('3', 'failed', detail)
      throw new StepFailure(detail)
    }
    if (!hasSs) {
      const detail = '中继上没有 `ss`，转发前预检无法判断端口占用'
      log.add('3', 'failed', detail)
      throw new StepFailure(detail)
    }
    if (!env.hasSystemctl) {
      const detail = '中继上没有 systemctl，无法重载 sshd 与 Caddy'
      log.add('3', 'failed', detail)
      throw new StepFailure(detail)
    }
    if (env.sshdUnit === '') {
      const detail = '找不到 sshd 的 systemd 单元（既没有 ssh.service 也没有 sshd.service）'
      log.add('3', 'failed', detail)
      throw new StepFailure(detail)
    }
    log.add('3', 'ok', `uid=${uid} ${env.osId} ${env.osVersion}；sudo=${useSudo ? '免密' : '不需要'}；sshd 单元=${env.sshdUnit}；sshd_config.d=${env.sshdInclude ? '有' : '无'}`)
  }

  /** 第 4 步：创建受限账号 `relay` 与其 `.ssh` 目录。 */
  async #stepRelayUser(deployment: Deployment, log: StepLog, signal: AbortSignal): Promise<void> {
    const result = await this.#remote(deployment, RELAY_USER_SCRIPT, { signal, privileged: true })
    if (result.exitCode !== 0) {
      const detail = `创建 relay 账号失败：${firstLine(result.stderr) || `退出码 ${String(result.exitCode)}`}`
      log.add('4', 'failed', detail)
      throw new StepFailure(detail)
    }
    const facts = parseKeyValues(result.stdout)
    log.add('4', 'ok', `relay 账号 ${facts['USER'] === 'created' ? '已创建' : '已存在'}，家目录 ${facts['HOME'] ?? '未知'}`)
  }

  /** 第 5 步：写隧道公钥的托管块。 */
  async #stepAuthorizedKeys(deployment: Deployment, log: StepLog, signal: AbortSignal): Promise<void> {
    const publicKey = (await readFile(this.deps.publicKeyPath, 'utf8')).trim()
    const template = await readTemplate('authorized_keys.snippet')
    const content = substitute(template, {
      PUBLIC_KEY: publicKey,
      RELAY_PORT: String(this.deps.relayPort),
    })
    const result = await this.#remote(deployment, managedBlockScript({
      path: '/home/relay/.ssh/authorized_keys', mode: 0o600, owner: 'relay', group: 'relay',
    }, content), { signal, privileged: true })
    if (result.exitCode !== 0) {
      const detail = `写 authorized_keys 失败：${firstLine(result.stderr) || `退出码 ${String(result.exitCode)}`}`
      log.add('5', 'failed', detail)
      throw new StepFailure(detail)
    }
    log.add('5', 'ok', `authorized_keys 托管块已写入，只允许监听 127.0.0.1:${String(this.deps.relayPort)}`)
  }

  /** 第 6 步：写 sshd 片段，`sshd -t` 通过才重载。 */
  async #stepSshd(deployment: Deployment, log: StepLog, signal: AbortSignal): Promise<void> {
    const env = this.#requireEnv()
    const template = await readTemplate('sshd_config.snippet')
    const content = substitute(template, {})
    const target: ManagedFile = env.sshdInclude
      ? { path: '/etc/ssh/sshd_config.d/60-dsh-web-relay.conf', mode: 0o644, guard: 'sshd -t' }
      : { path: '/etc/ssh/sshd_config', mode: 0o644, guard: 'sshd -t' }
    const script = [
      managedBlockScript(target, content),
      `systemctl reload ${env.sshdUnit}`,
      'sshd -T -C user=relay,host=relay,addr=127.0.0.1 | grep -E "^(gatewayports|permitopen|allowtcpforwarding|permittty|clientaliveinterval|clientalivecountmax|unusedconnectiontimeout) " || true',
      '',
    ].join('\n')
    const result = await this.#remote(deployment, script, { signal, privileged: true })
    if (result.exitCode !== 0) {
      const detail = `sshd 片段未生效（已回滚）：${firstLine(result.stderr) || `退出码 ${String(result.exitCode)}`}`
      log.add('6', 'failed', detail)
      throw new StepFailure(detail)
    }
    const effective = result.stdout.trim().split('\n').filter(line => line !== '').join('；')
    log.add('6', 'ok', `${target.path}；生效值：${effective}`)
  }

  /** 第 7 步：装 Caddy 与 fail2ban。 */
  async #stepPackages(deployment: Deployment, log: StepLog, signal: AbortSignal): Promise<void> {
    const env = this.#requireEnv()
    if (!env.hasApt) {
      const detail = '中继上找不到 apt-get；自动安装 Caddy 与 fail2ban 只支持 Debian/Ubuntu，请在'
        + '目标机上手动安装成功后点「重新引导」'
      log.add('7', 'failed', detail)
      throw new StepFailure(detail)
    }
    const result = await this.#remote(deployment, PACKAGES_SCRIPT, {
      signal, privileged: true, timeoutMs: this.deps.stepTimeoutMs,
    })
    if (result.exitCode !== 0) {
      const detail = `安装 Caddy 或 fail2ban 失败：${firstLine(result.stderr) || `退出码 ${String(result.exitCode)}`}`
      log.add('7', 'failed', detail)
      throw new StepFailure(detail)
    }
    const facts = parseKeyValues(result.stdout)
    this.#caddyVersion = facts['CADDY'] ?? ''
    log.add('7', 'ok', `Caddy${this.#caddyVersion === '' ? '（沿用已有安装）' : ` ${this.#caddyVersion}`}、fail2ban 均就绪`)
  }

  /** 第 8 步：算 bcrypt。明文只走 stdin，不进 argv、不落盘、不进日志。 */
  async #stepGatewayHash(deployment: Deployment, log: StepLog, signal: AbortSignal): Promise<string> {
    if (deployment.password === '') {
      const detail = 'gateway.password 为空'
      log.add('8', 'failed', detail)
      throw new StepFailure(detail)
    }
    const target = this.#target(deployment)
    // 结尾换行是必须的：不带时 `caddy hash-password` 报 `Error: EOF` 且不输出哈希。
    const result = await runSsh(this.deps.subprocess, {
      argv: commandArgv(target, 'caddy hash-password'),
      cwd: this.deps.cwd,
      stdin: `${deployment.password}\n`,
      timeoutMs: this.deps.commandTimeoutMs,
      graceMs: this.deps.graceMs,
      signal,
    })
    const hash = result.stdout.trim()
    if (result.exitCode !== 0 || !hash.startsWith('$2')) {
      const detail = `caddy hash-password 没有给出 bcrypt 哈希：${firstLine(result.stderr) || '输出为空'}`
      log.add('8', 'failed', detail)
      throw new StepFailure(detail)
    }
    log.add('8', 'ok', '网关口令已哈希（bcrypt，明文未离开本机内存）')
    return hash
  }

  /** 第 9 步：写 Caddyfile、格式化、校验、重载，再写 Caddy 侧的 fail2ban jail。 */
  async #stepCaddyfile(deployment: Deployment, log: StepLog, signal: AbortSignal, hash: string): Promise<void> {
    const authority = deployment.authority
    if (authority === undefined) {
      const detail = 'vps.host 为空或形状非法，推不出公网权威'
      log.add('9', 'failed', detail)
      throw new StepFailure(detail)
    }
    const precheck = await this.#remote(deployment, caddyPrecheckScript(deployment.gatewayPort), { signal, privileged: true })
    if (precheck.exitCode !== 0 || !precheck.stdout.startsWith('OK')) {
      const detail = firstLine(precheck.stdout) || firstLine(precheck.stderr) || '检查既有 Caddyfile 失败'
      log.add('9', 'failed', detail)
      throw new StepFailure(detail)
    }
    const template = await readTemplate('Caddyfile.snippet')
    const content = renderCaddyfile(template, {
      authority,
      hostname: deployment.hostname ?? deployment.host,
      gatewayPort: deployment.gatewayPort,
      relayPort: this.deps.relayPort,
      sessionSecret: this.deps.sessionSecret(),
      passwordHash: hash,
    })
    const script = [
      managedBlockScript({
        path: '/etc/caddy/Caddyfile',
        mode: 0o644,
        // 全局选项块必须在文件最前面；块外的既有站点留在后面不动。
        position: 'top',
        // 校验要在 `caddy` 账号的数据目录下跑，否则本地 CA 解析不到，会报一个与
        // 配置无关的错。`fmt` 命中同一行才能在失败时由 `guard` 一起回滚。
        guard: 'caddy fmt --overwrite /etc/caddy/Caddyfile'
          + ' && XDG_DATA_HOME=/var/lib/caddy/.local/share XDG_CONFIG_HOME=/var/lib/caddy/.config'
          + ' caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile',
      }, content),
      'systemctl reload caddy',
      'systemctl is-active caddy',
      '',
    ].join('\n')
    const result = await this.#remote(deployment, script, { signal, privileged: true, timeoutMs: this.deps.stepTimeoutMs })
    if (result.exitCode !== 0) {
      const detail = `Caddyfile 未生效（校验失败时已回滚）：${firstLine(result.stderr) || `退出码 ${String(result.exitCode)}`}`
      log.add('9', 'failed', detail)
      throw new StepFailure(detail)
    }
    // jail 写坏不会影响已经工作的入口，因此它的失败只标在 detail 上。
    const jail = await this.#writeFail2banJail(deployment, signal)
    log.add('9', 'ok', `Caddyfile 已生效（caddy ${lastLine(result.stdout) || 'active'}）${jail}`)
  }

  /** 第 9 步的附带动作：Caddy 侧 jail。返回要追加到 detail 的说明。 */
  async #writeFail2banJail(deployment: Deployment, signal: AbortSignal): Promise<string> {
    try {
      const filter = await readTemplate('fail2ban/filter.d/caddy-dsh-relay.conf')
      const jail = substitute(await readTemplate('fail2ban/jail.d/caddy-dsh-relay.conf'), {
        GATEWAY_PORT: String(deployment.gatewayPort),
        // 取不到就是空串：jail 退回默认封禁规则，而不是填一个猜出来的地址。
        HOME_EGRESS_IP: this.#egressAddress ?? '',
      })
      const script = [
        wholeFileScript({ path: '/etc/fail2ban/filter.d/caddy-dsh-relay.conf', mode: 0o644 }, filter),
        wholeFileScript({ path: '/etc/fail2ban/jail.d/caddy-dsh-relay.conf', mode: 0o644 }, jail),
        'fail2ban-client reload',
        '',
      ].join('\n')
      const result = await this.#remote(deployment, script, { signal, privileged: true })
      if (result.exitCode !== 0) {
        return `；Caddy 侧 fail2ban jail 未生效：${firstLine(result.stderr) || `退出码 ${String(result.exitCode)}`}`
      }
      return '；Caddy 侧 fail2ban jail 已生效'
    } catch (error) {
      return `；Caddy 侧 fail2ban jail 未生效：${describeError(error)}`
    }
  }

  /** 第 10 步：取回 CA 根证书并算指纹。 */
  async #stepCaCert(deployment: Deployment, log: StepLog, signal: AbortSignal): Promise<string> {
    const result = await this.#remote(deployment, caCertScript(deployment), {
      signal, privileged: true, timeoutMs: this.deps.stepTimeoutMs,
    })
    const pem = result.stdout
    if (result.exitCode !== 0 || !pem.includes('BEGIN CERTIFICATE')) {
      const detail = `读不到 CA 根证书：${firstLine(result.stderr) || '输出里没有 PEM 块'}`
      log.add('10', 'failed', detail)
      throw new StepFailure(detail)
    }
    await mkdir(dirname(this.deps.caCertPath), { recursive: true, mode: 0o755 })
    const staged = `${this.deps.caCertPath}.staged`
    await writeFile(staged, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o644 })
    await rename(staged, this.deps.caCertPath)
    const printed = await runLocal(this.deps, [
      this.#tool('openssl'), 'x509', '-noout', '-fingerprint', '-sha256', '-in', this.deps.caCertPath,
    ])
    const fingerprint = (printed.stdout.match(/Fingerprint=(\S+)/)?.[1] ?? '').trim()
    if (fingerprint === '') {
      const detail = `根证书已取回，但算不出指纹：${firstLine(printed.stderr)}`
      log.add('10', 'failed', detail)
      throw new StepFailure(detail)
    }
    log.add('10', 'ok', `根证书已保存到 ${this.deps.caCertPath}，SHA256 指纹 ${fingerprint}`)
    return fingerprint
  }

  /** 管理连接的身份。 */
  #target(deployment: Deployment): SshTarget {
    return {
      host: deployment.host,
      port: deployment.sshPort,
      user: deployment.user,
      identityFile: deployment.identityFile,
      knownHostsFile: this.deps.knownHostsFile,
      connectTimeoutSec: this.deps.connectTimeoutSec,
      extraOptions: {},
    }
  }

  /**
   * 跑一段远端脚本。
   * @param deployment - 部署参数。
   * @param script - 脚本全文，走 stdin。
   * @param options - 是否提权、超时、取消信号。
   * @returns 命令结果。
   */
  async #remote(
    deployment: Deployment,
    script: string,
    options: { signal: AbortSignal; privileged?: boolean; timeoutMs?: number },
  ): Promise<SshRunResult> {
    const env = this.#env
    const needsSudo = options.privileged === true && (env === undefined ? deployment.user !== 'root' : env.useSudo)
    const command = needsSudo ? 'sudo -n sh -s' : 'sh -s'
    return await runSsh(this.deps.subprocess, {
      argv: commandArgv(this.#target(deployment), command),
      cwd: this.deps.cwd,
      stdin: script,
      timeoutMs: options.timeoutMs ?? this.deps.commandTimeoutMs,
      graceMs: this.deps.graceMs,
      signal: options.signal,
    })
  }

  /** 读 `known_hosts` 的指纹列表。 */
  async #fingerprintsOf(path: string): Promise<HostKeyFingerprint[]> {
    const printed = await runLocal(this.deps, [this.#tool('ssh-keygen'), '-lf', path])
    return parseFingerprints(printed.stdout)
  }

  /** 环境事实必须已由第 3 步填上。 */
  #requireEnv(): RemoteEnvironment {
    if (this.#env === undefined) throw new StepFailure('环境探测尚未完成')
    return this.#env
  }

  /** 本机工具的绝对路径。 */
  #tool(name: string): string {
    const found = this.#tools[name]
    if (found === undefined) throw new StepFailure(`本机工具 ${name} 尚未定位`)
    return found
  }
}

/** 第 3 步的探测脚本。只输出 `KEY=VALUE`，便于解析。 */
const PROBE_SCRIPT = [
  'set -u',
  // 读出口地址，供第 9 步的 fail2ban `ignoreip` 使用。这次探测不提权（它全程都用
  // 管理账号跑），因此 sshd 交给登录 shell 的 `SSH_CONNECTION` 还在——`sudo` 会把它
  // 清掉，所以不能挪到任何一个提权步骤里去取。写 `-` 兜底：万一某天它不在了，这一步
  // 只是拿不到地址，不该让整条探测失败。
  'echo "EGRESS=${SSH_CONNECTION-}"',
  'echo "UID=$(id -u)"',
  'if [ -r /etc/os-release ]; then . /etc/os-release; echo "OS_ID=${ID:-}"; echo "OS_VERSION=${VERSION_ID:-}";',
  'else echo "OS_ID="; echo "OS_VERSION="; fi',
  'if command -v ss >/dev/null 2>&1; then echo "HAS_SS=1"; else echo "HAS_SS=0"; fi',
  'if command -v apt-get >/dev/null 2>&1; then echo "HAS_APT=1"; else echo "HAS_APT=0"; fi',
  'if command -v systemctl >/dev/null 2>&1; then echo "HAS_SYSTEMCTL=1"; else echo "HAS_SYSTEMCTL=0"; fi',
  'if [ "$(id -u)" = 0 ]; then echo "SUDO=root";',
  'elif sudo -n true >/dev/null 2>&1; then echo "SUDO=ok";',
  'else echo "SUDO=missing"; fi',
  'if [ -r /etc/ssh/sshd_config ] && grep -qE "^[[:space:]]*Include[[:space:]]+.*sshd_config\\.d" /etc/ssh/sshd_config; then echo "SSHD_INCLUDE=1"; else echo "SSHD_INCLUDE=0"; fi',
  'sshd_unit=""',
  'for unit in ssh sshd; do',
  '  if systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${unit}\\.service"; then sshd_unit=$unit; break; fi',
  'done',
  'echo "SSHD_UNIT=$sshd_unit"',
  'exit 0',
  '',
].join('\n')

/** 第 4 步的脚本。 */
const RELAY_USER_SCRIPT = [
  'set -eu',
  'if getent passwd relay >/dev/null 2>&1; then echo "USER=exists";',
  'else',
  '  if ! command -v useradd >/dev/null 2>&1; then echo "没有 useradd，请手动创建 relay 账号" >&2; exit 1; fi',
  '  nologin=/usr/sbin/nologin',
  '  if [ ! -x "$nologin" ]; then nologin=/sbin/nologin; fi',
  '  useradd --create-home --shell "$nologin" relay',
  '  echo "USER=created"',
  'fi',
  'install -d -m 0700 -o relay -g relay /home/relay/.ssh',
  'echo "HOME=$(getent passwd relay | cut -d: -f6)"',
  'exit 0',
  '',
].join('\n')

/** 第 7 步的脚本。`command -v` 命中即跳过对应安装，两者独立判断。 */
const PACKAGES_SCRIPT = [
  'set -eu',
  'export DEBIAN_FRONTEND=noninteractive',
  'need_caddy=1',
  'if command -v caddy >/dev/null 2>&1; then need_caddy=0; fi',
  'need_f2b=1',
  'if command -v fail2ban-server >/dev/null 2>&1; then need_f2b=0; fi',
  'if [ "$need_caddy" = 0 ] && [ "$need_f2b" = 0 ]; then echo "CADDY="; echo SKIP=both; exit 0; fi',
  'apt-get update -qq',
  'if [ "$need_caddy" = 1 ]; then',
  '  apt-get install -y -qq ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https',
  "  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
  "  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list",
  '  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list',
  '  apt-get update -qq',
  '  apt-get install -y -qq caddy',
  '  systemctl enable --now caddy',
  '  echo "CADDY=$(caddy version 2>/dev/null || echo unknown)"',
  'fi',
  'if [ "$need_f2b" = 1 ]; then',
  '  apt-get install -y -qq fail2ban',
  '  systemctl enable --now fail2ban',
  'fi',
  'exit 0',
  '',
].join('\n')

/**
 * 第 9 步写之前的冲突检查。
 *
 * Caddy 只允许一个全局选项块，而具名片段的名字必须全文件唯一；此外块外已经有站点
 * 监听同一个端口时，写入会让两个站点抢同一个端口。三种情况都停下让用户自己合并，
 * 插件不擅自改写别人的配置。
 * @param gatewayPort - 网关端口。
 * @returns 脚本全文。
 */
function caddyPrecheckScript(gatewayPort: number): string {
  return [
    'set -eu',
    'f=/etc/caddy/Caddyfile',
    'if [ ! -f "$f" ]; then echo OK; exit 0; fi',
    `outside=$(awk '/^# BEGIN dsh-web-relay$/ { inside = 1 } inside == 0 { print } /^# END dsh-web-relay$/ { inside = 0 }' "$f")`,
    `hit=$(printf '%s\\n' "$outside" | grep -nE '^[[:space:]]*(auto_https|default_sni)([[:space:]]|$)|^[[:space:]]*pki([[:space:]]|$)' | head -n 3 || true)`,
    'if [ -n "$hit" ]; then echo "既有 Caddyfile 的块外已有全局选项块，请自行合并后重试：$hit"; exit 0; fi',
    `frag=$(printf '%s\\n' "$outside" | grep -nF '(dsh-relay-upstream)' | head -n 3 || true)`,
    'if [ -n "$frag" ]; then echo "既有 Caddyfile 的块外已存在同名片段 dsh-relay-upstream，请自行改名后重试：$frag"; exit 0; fi',
    `site=$(printf '%s\\n' "$outside" | grep -nE "(^|[^0-9]):${String(gatewayPort)}([^0-9]|$)" | head -n 3 || true)`,
    'if [ -n "$site" ]; then echo "既有 Caddyfile 的块外已有站点监听 '
      + `:${String(gatewayPort)}，请自行处理端口冲突后重试：$site"; exit 0; fi`,
    'echo OK',
    'exit 0',
    '',
  ].join('\n')
}

/**
 * 第 10 步读根证书的脚本。
 *
 * CA 在配置装载时生成，因此 reload 之后通常立刻就在；重试是给"装载与生成之间"留
 * 余量。仍然没有就用一次本地 TLS 握手把签发逼出来。
 * @param deployment - 部署参数。
 * @returns 脚本全文。
 */
function caCertScript(deployment: Deployment): string {
  const path = '/var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/root.crt'
  const retry = [
    'i=0',
    'while [ $i -lt 20 ]; do',
    `  if [ -f ${shellQuote(path)} ]; then cat ${shellQuote(path)}; exit 0; fi`,
    '  sleep 0.5',
    '  i=$((i + 1))',
    'done',
  ]
  return [
    'set -eu',
    ...retry,
    'if command -v openssl >/dev/null 2>&1; then',
    `  openssl s_client -connect 127.0.0.1:${String(deployment.gatewayPort)} -servername ${shellQuote(deployment.host)} </dev/null >/dev/null 2>&1 || true`,
    'fi',
    ...retry,
    `echo "根证书未出现：${path}" >&2`,
    'exit 1',
    '',
  ].join('\n')
}

/**
 * 在本机跑一条命令。
 * @param deps - 引导依赖（用到 subprocess 与超时）。
 * @param argv - 完整 argv。
 * @param timeoutMs - 超时；默认用单条命令的超时。
 * @returns 命令结果。
 */
async function runLocal(
  deps: BootstrapDeps,
  argv: readonly string[],
  timeoutMs?: number,
): Promise<SshRunResult> {
  return await runSsh(deps.subprocess, {
    argv,
    cwd: deps.cwd,
    timeoutMs: timeoutMs ?? deps.commandTimeoutMs,
    graceMs: deps.graceMs,
  })
}

/**
 * 在 `PATH` 上找一个可执行文件。
 * @param name - 文件名。
 * @returns 绝对路径；找不到时为 undefined。
 */
async function localTool(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // 这个目录里没有；继续找下一个。
    }
  }
  return undefined
}

/**
 * 判断路径是否存在。
 * @param path - 绝对路径。
 * @returns 存在时为 true。
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    // 不存在（或不可读）都按"没有"处理。
    return false
  }
}

/**
 * 解析 `KEY=VALUE` 行。
 * @param output - 脚本 stdout。
 * @returns 键值对；后面的同名键覆盖前面的。
 */
export function parseKeyValues(output: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return values
}

/**
 * 取输出的最后一行非空内容。
 * @param text - 原始输出。
 * @returns 最后一行；没有内容时为空串。
 */
function lastLine(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines[lines.length - 1] ?? ''
}

/**
 * 步骤记录里最后一条的编号。
 * @param log - 步骤记录器。
 * @returns 编号；一条都没有时为 `0`。
 */
function lastRecorded(log: StepLog): string {
  const last = log.steps[log.steps.length - 1]
  return last?.id ?? '0'
}

/**
 * 把任意抛出物压成一行可读文本。
 * @param error - 抛出物。
 * @returns 一行摘要。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
