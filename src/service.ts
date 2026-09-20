/**
 * `webRelay` 服务面与它的实现。
 *
 * 服务面只有三个成员，因为 `connection` 行的 `!!js` 表达式只需要一个受信列表；
 * 把引导、隧道、预检都摊到服务面上会让那一行变成一个万能入口。真正的编排在
 * {@link RelayRuntime} 里，它对内是插件的中枢，对外只暴露这一小片。
 * @module dsh-web-relay/service
 */

import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Bootstrap, StepLog } from './bootstrap.js'
import type { ResolvedRelayConfig } from './config.js'
import { diff, isRunnable, needsBootstrap, needsTunnelRestart, type Deployment } from './deployment.js'
import { registerEntryRoute } from './entry.js'
import { caCert, knownHosts, relayPrivateKey, relayPublicKey, relayRoot, sshDir } from './paths.js'
import { Preflight, type PreflightOutcome } from './preflight.js'
import { adminTarget, commandArgv, firstLine, privilegedCommand, runSsh } from './ssh.js'
import { RelaySettings } from './settings.js'
import { Trust } from './trust.js'
import { Tunnel, type RelayLogger, type TunnelState } from './tunnel.js'

/** 插件提供的服务名，`cordis.patch.yml` 里的表达式按它取。 */
export const WEB_RELAY_SERVICE = 'webRelay'

/** 引导与隧道的合并状态。 */
export type RelayState = 'unconfigured' | 'bootstrapping' | 'ready' | 'failed'

/** `webRelay.status()` 的返回值。 */
export interface RelayStatus {
  /** 合并状态。 */
  readonly state: RelayState
  /** 已生效的权威；未配置时为空。 */
  readonly authority: string
  /** 隧道守护的状态。 */
  readonly tunnel: TunnelState
  /** 隧道本次连接已经活了多久（毫秒）。 */
  readonly tunnelUptimeMs?: number
  /** 最近一次转发前预检。 */
  readonly lastPreflight?: PreflightOutcome
  /** 最近一次失败的原文摘要，成功时为空。 */
  readonly lastError: string
}

/** 插件提供给 DSH 的服务面。 */
export interface WebRelayHandle {
  /**
   * 公网权威，供 Host/Origin 围栏的受信列表使用。
   *
   * 是取值器而不是快照：`!!js` 表达式在 `connection` 行重解析时现取，因此权威
   * 变化之后只要再触发一次重解析就够了，不需要改写配置文件。
   */
  readonly trustedHosts: readonly string[]
  /**
   * 当前权威。
   * @returns `host:port`；未配置时为空字符串。
   */
  authority(): string
  /**
   * 当前状态。
   * @returns 一份快照。
   */
  status(): RelayStatus
}

/** 运行期的依赖。 */
export interface RelayRuntimeDeps {
  /** 插件上下文。 */
  readonly ctx: Context
  /** 日志。 */
  readonly logger: RelayLogger
  /** 路由载体。 */
  readonly webServer: WebServer
  /** DSH 的子进程 seam。 */
  readonly subprocess: SubprocessRuntime
  /** 补齐后的插件配置。 */
  readonly config: ResolvedRelayConfig
}

/**
 * 插件的中枢。
 *
 * 它把三件互相独立的事接在一起：设置变化决定"该重做什么"，引导与隧道执行动作，
 * 记录把结果交回卡片。对账入口只有 {@link RelayRuntime.reconcile} 一个，因此
 * "启动时"与"用户改设置时"走的是同一条判断路径。
 */
export class RelayRuntime {
  /** 交给 `ctx.provide` 的服务面。 */
  readonly handle: WebRelayHandle
  readonly #settings: RelaySettings
  readonly #tunnel: Tunnel
  readonly #preflight: Preflight
  readonly #trust: Trust
  readonly #bootstrap: Bootstrap
  /** 上一次对账用的部署快照。 */
  #previous: Deployment | undefined
  /** 当前权威。 */
  #authority = ''
  /** 当前状态。 */
  #state: RelayState = 'unconfigured'
  /** 最近一次失败。 */
  #lastError = ''
  /** 最近一次预检。 */
  #lastPreflight: PreflightOutcome | undefined
  /** 正在跑的那一次引导；用它可以避免连点两次"重新引导"变成两次并发引导。 */
  #running: Promise<void> | undefined
  /** 网关会话密钥。 */
  #sessionSecret = ''

  /**
   * @param deps - 运行期依赖。
   * @param settings - 两个设置命名空间的门面；必须已注册。
   */
  constructor(private readonly deps: RelayRuntimeDeps, settings: RelaySettings) {
    this.#settings = settings
    const { config } = deps
    this.#trust = new Trust(deps.ctx, deps.logger, config.logLabel)
    this.#preflight = new Preflight({
      subprocess: deps.subprocess,
      logger: deps.logger,
      cwd: relayRoot(),
      logLabel: config.logLabel,
      knownHostsFile: knownHosts(),
      connectTimeoutSec: config.connectTimeoutSec,
      commandTimeoutMs: config.commandTimeoutMs,
      graceMs: config.graceMs,
    })
    this.#tunnel = new Tunnel({
      subprocess: deps.subprocess,
      logger: deps.logger,
      cwd: relayRoot(),
      logLabel: config.logLabel,
      relayPort: config.relayPort,
      backoffMs: config.backoffMs,
      healthyAfterMs: config.healthyAfterMs,
      graceMs: config.graceMs,
      extraOptions: config.extraOptions,
      connectTimeoutSec: config.connectTimeoutSec,
      knownHostsFile: knownHosts(),
      identityFile: relayPrivateKey(),
      dshPort: () => deps.webServer.port,
      beforeConnect: async (deployment, signal) => {
        this.#lastPreflight = await this.#preflight.run(deployment, config.relayPort, signal)
        await this.#settings.patchRecord({ lastPreflight: this.#lastPreflight })
      },
      onState: (state) => { this.#onTunnelState(state) },
    })
    this.#bootstrap = new Bootstrap({
      subprocess: deps.subprocess,
      logger: deps.logger,
      logLabel: config.logLabel,
      cwd: relayRoot(),
      knownHostsFile: knownHosts(),
      privateKeyPath: relayPrivateKey(),
      publicKeyPath: relayPublicKey(),
      caCertPath: caCert(),
      relayPort: config.relayPort,
      connectTimeoutSec: config.connectTimeoutSec,
      commandTimeoutMs: config.commandTimeoutMs,
      stepTimeoutMs: config.stepTimeoutMs,
      graceMs: config.graceMs,
      // 取值器：口令变化时会话密钥会换掉，引导读到的必须是那一刻的那一份。
      sessionSecret: () => this.#sessionSecret,
    })
    this.handle = {
      get trustedHosts(): readonly string[] {
        return thisAuthorityOf(settings) === '' ? [] : [thisAuthorityOf(settings)]
      },
      authority: () => this.#authority,
      status: () => this.#status(),
    }
  }

  /**
   * 首次对账：建目录、注册入口、读设置并决定要做什么。
   *
   * 必须在 `apply` 里同步完成目录准备与路由注册，因此这里只把耗时的对账留成
   * 后台任务——`connection` 行不依赖对账结果，它只依赖服务面已经 provide。
   */
  async start(): Promise<void> {
    await mkdir(sshDir(), { recursive: true, mode: 0o700 })
    this.#sessionSecret = await this.#ensureSessionSecret()
    const raw = this.#settings.record()
    this.#state = raw.state === 'ready' ? 'ready' : 'unconfigured'
    this.#lastError = raw.lastError ?? ''
    this.#lastPreflight = raw.lastPreflight
    this.#settings.watch((next) => this.#onSettingsChange(next))
    void this.reconcile()
  }

  /**
   * 对账：按当前部署参数与记录决定要不要引导、要不要拉隧道。
   *
   * 启动时与设置变化时都走这里。两条路径共用一份判断，是因为"重启 DSH"与"改了
   * 地址再保存"在用户眼里是同一件事：让服务变成该有的样子。
   * @returns 落定于本次对账结束。
   */
  async reconcile(): Promise<void> {
    const next = this.#settings.deployment()
    const previous = this.#previous
    this.#previous = next
    const change = diff(previous, next)
    this.#authority = next.authority ?? ''

    if (change.authority) {
      this.#trust.apply()
      if (this.#authority !== '') {
        const check = await this.#trust.selfCheck(
          this.#authority, this.deps.webServer.port, this.deps.config.probeTimeoutMs,
        )
        this.deps.logger[check.ok ? 'info' : 'warn']('%s %s', this.deps.config.logLabel, check.detail)
      }
    }

    if (!isRunnable(next)) {
      await this.#tunnel.stop()
      this.#state = 'unconfigured'
      await this.#settings.patchRecord({
        state: 'unconfigured', publicAuthority: '', updatedAt: new Date().toISOString(),
      })
      return
    }

    const record = this.#settings.record()
    const ready = record.state === 'ready' && record.publicAuthority === this.#authority
    if (needsBootstrap(change) || !ready) {
      await this.runBootstrap(next, change.password)
      return
    }

    // 记录说「中继上已经配好了」，但隧道是一条活的连接，不随 DSH 重启存活：
    // 首次对账（`previous === undefined`）因此也要把隧道重新拉起来，否则重启
    // 一台本来就就绪的主机只会在记录里显示 running，而实际什么都连不上。
    if (change.autoStart || previous === undefined || needsTunnelRestart(change)) {
      if (next.autoStart) await this.#tunnel.start(next)
      else await this.#tunnel.stop()
    }
  }

  /**
   * 跑完整引导（第 0–13 步）并更新记录。
   *
   * 并发调用会挂在同一次运行上：连点两次"重新引导"不该变成两次并发引导。
   * @param deployment - 部署参数。
   * @param passwordChanged - 口令是否刚刚变过；变过就换一份会话密钥。
   * @returns 落定于本次引导结束。
   */
  async runBootstrap(deployment: Deployment, passwordChanged: boolean): Promise<void> {
    if (this.#running !== undefined) return await this.#running
    this.#running = this.#doBootstrap(deployment, passwordChanged)
      .finally(() => { this.#running = undefined })
    return await this.#running
  }

  /** {@link RelayRuntime.runBootstrap} 的实现。 */
  async #doBootstrap(deployment: Deployment, passwordChanged: boolean): Promise<void> {
    const label = this.deps.config.logLabel
    if (passwordChanged || this.#sessionSecret === '') {
      this.#sessionSecret = await this.#ensureSessionSecret(true)
    }
    this.#state = 'bootstrapping'
    this.#lastError = ''
    const log = new StepLog()
    await this.#settings.patchRecord({
      state: 'bootstrapping', steps: [], lastError: '', updatedAt: new Date().toISOString(),
    })
    this.deps.logger.info('%s 开始引导 %s@%s', label, deployment.user, deployment.host)

    const outcome = await this.#bootstrap.run(deployment, log, new AbortController().signal)

    if (!outcome.ok) {
      log.skipAfter(lastStepId(log), outcome.error ?? '引导失败')
      this.#state = 'failed'
      this.#lastError = outcome.error ?? '引导失败'
      await this.#settings.patchRecord({
        state: 'failed',
        steps: [...log.steps],
        lastError: this.#lastError,
        observedHostKeyFingerprint: outcome.hostKeyFingerprint,
        updatedAt: new Date().toISOString(),
      })
      this.deps.logger.error('%s 引导失败：%s', label, this.#lastError)
      return
    }

    // 第 11 步：注册权威并自检。
    const authority = deployment.authority ?? ''
    this.#trust.apply()
    const selfCheck = await this.#trust.selfCheck(authority, this.deps.webServer.port, this.deps.config.probeTimeoutMs)
    log.add('11', selfCheck.ok ? 'ok' : 'failed', selfCheck.detail)

    // 第 12 步：拉起隧道，等它真的活过健康阈值。
    await this.#tunnel.start(deployment)
    const healthy = await this.#waitForTunnel()
    log.add('12', healthy ? 'ok' : 'failed', healthy
      ? `隧道已连接，中继上 127.0.0.1:${String(this.deps.config.relayPort)} 指向本机 ${String(this.deps.webServer.port)}`
      : `隧道未在预期时间内进入 running（当前 ${this.#tunnel.state()}）`)

    // 第 13 步：公网自检。
    let publicCheck = '未执行（selfCheck.publicProbe 关闭）'
    let publicOk = true
    if (this.deps.config.publicProbe) {
      const probe = await this.#trust.publicProbe(authority, caCert(), this.deps.config.probeTimeoutMs, {
        sessionSecret: this.#sessionSecret,
        entryEnabled: this.deps.config.entryEnabled,
      })
      publicCheck = probe.detail
      publicOk = probe.ok
    }
    const exposed = await this.#exposedPorts(deployment)
    log.add('13', publicOk ? 'ok' : 'failed', `${publicCheck}；中继对外监听：${exposed}`)

    const caFingerprint = outcome.caFingerprint
    this.#state = selfCheck.ok && healthy && publicOk ? 'ready' : 'failed'
    this.#lastError = this.#state === 'ready' ? '' : selfCheck.ok ? (healthy ? publicCheck : '隧道未连接') : selfCheck.detail
    await this.#settings.patchRecord({
      state: this.#state,
      publicAuthority: authority,
      observedHostKeyFingerprint: outcome.hostKeyFingerprint,
      caFingerprint,
      gateway: { sessionSecret: this.#sessionSecret },
      steps: [...log.steps],
      lastError: this.#lastError,
      updatedAt: new Date().toISOString(),
    })
    this.#banner(deployment, caFingerprint, outcome.caddyVersion)
  }

  /**
   * 等隧道进入 `running`。
   * @returns 进入 running 时为 true。
   */
  async #waitForTunnel(): Promise<boolean> {
    const deadline = Date.now() + this.deps.config.healthyAfterMs + 30000
    while (Date.now() < deadline) {
      if (this.#tunnel.state() === 'running') return true
      await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
    }
    return this.#tunnel.state() === 'running'
  }

  /**
   * 中继上对外可达的 TCP 监听。
   *
   * 引导会装 Caddy，而发行版自带的 `/etc/caddy/Caddyfile` 末尾还有一个 `:80` 静态
   * 站点；托管块按约不碰块外内容，所以「实际暴露了什么」必须观测一次并写进记录。
   * 不观测时「只开了 8443」是一个假设，而假设不会在扫描器找上来时提醒任何人。
   * @param deployment - 中继地址与管理账号。
   * @returns 一行监听列表；读不到时是一行原因。
   */
  async #exposedPorts(deployment: Deployment): Promise<string> {
    const target = adminTarget(deployment, knownHosts(), this.deps.config.connectTimeoutSec)
    const result = await runSsh(this.deps.subprocess, {
      argv: commandArgv(target, privilegedCommand(deployment.user, 'ss -ltnpH')),
      cwd: relayRoot(),
      timeoutMs: this.deps.config.commandTimeoutMs,
      graceMs: this.deps.config.graceMs,
    })
    if (result.exitCode !== 0) {
      return `读不到（${firstLine(result.stderr) || `退出码 ${String(result.exitCode)}`}）`
    }
    const listeners = new Set<string>()
    for (const line of result.stdout.split('\n')) {
      const local = line.trim().split(/\s+/)[3]
      if (local === undefined) continue
      // 只看地址部分：systemd-resolved 的 `127.0.0.53%lo:53` 带作用域后缀，整个
      // 回环网段都不是「对外」，而 `*`、`0.0.0.0`、`[::]` 是。
      const address = local.slice(0, local.lastIndexOf(':')).split('%')[0] ?? ''
      if (address.startsWith('127.') || address === '[::1]') continue
      listeners.add(local)
    }
    return listeners.size === 0 ? '（无）' : [...listeners].sort().join('、')
  }

  /**
   * 引导结束时打印入口信息。
   *
   * 这一行走 stdout 而不是日志：终端里跑 `dsh --profile relay` 的人需要的
   * 就是这一行可以复制到手机上的地址，与 `dsh web:` 那一行同一个理由、同一个位置。
   * 地址是裸权威——没带会话 Cookie 的文档导航由中继在内部改写成换票点，换票点这条
   * 路径不进地址栏，也不进这一行。详情留在 `ctx.logger` 上，记录留在设置里。
   */
  #banner(deployment: Deployment, caFingerprint: string, caddyVersion: string): void {
    const authority = deployment.authority ?? ''
    const label = this.deps.config.logLabel
    const ok = this.#state === 'ready'
    console.log(`${label}: https://${authority}/`
      + `${ok ? '' : '（有步骤失败，详见卡片）'}`
      + `\n  根证书指纹 ${caFingerprint}`
      + `\n  中继主机密钥 ${deployment.hostKeyFingerprint ?? '（未固定，见卡片记录）'}`
      + `\n  Caddy ${caddyVersion === '' ? '沿用已有安装' : caddyVersion}`)
    this.deps.logger.info('%s 引导结束：%s', label, ok ? '就绪' : this.#lastError)
  }

  /** 设置变化时重新对账。 */
  async #onSettingsChange(next: Deployment): Promise<void> {
    void next
    await this.reconcile()
  }

  /** 隧道状态变化时写回记录，供卡片显示。 */
  #onTunnelState(state: TunnelState): void {
    void this.#settings.patchRecord({ tunnelState: state }).catch((error: unknown) => {
      this.deps.logger.warn('%s 写入隧道状态失败：%s', this.deps.config.logLabel, describeError(error))
    })
    this.deps.logger.info('%s 隧道状态：%s', this.deps.config.logLabel, state)
  }

  /**
   * 读或生成网关会话密钥。
   * @param regenerate - 为 true 时无条件生成新的。
   * @returns 会话密钥。
   */
  async #ensureSessionSecret(regenerate = false): Promise<string> {
    const existing = this.#settings.record().gateway?.sessionSecret ?? ''
    if (!regenerate && existing !== '') return existing
    const secret = randomBytes(24).toString('base64url')
    await this.#settings.patchRecord({ gateway: { sessionSecret: secret } })
    return secret
  }

  /** 当前状态快照。 */
  #status(): RelayStatus {
    return {
      state: this.#state,
      authority: this.#authority,
      tunnel: this.#tunnel.state(),
      ...this.#tunnel.uptimeMs() === undefined ? {} : { tunnelUptimeMs: this.#tunnel.uptimeMs() },
      ...this.#lastPreflight === undefined ? {} : { lastPreflight: this.#lastPreflight },
      lastError: this.#lastError,
    }
  }

  /**
   * 插件卸载：停隧道、撤路由。
   * @returns 落定于清理完成。
   */
  async dispose(): Promise<void> {
    await this.#tunnel.stop()
  }
}

/**
 * 把任意抛出物压成一行可读文本。
 * @param error - 抛出物。
 * @returns 一行摘要。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 当前权威，供服务面的取值器使用。
 * @param settings - 设置门面。
 * @returns `host:port`；未配置时为空字符串。
 */
function thisAuthorityOf(settings: RelaySettings): string {
  return settings.deployment().authority ?? ''
}

/**
 * 记录里最后一步的编号。
 * @param log - 步骤记录器。
 * @returns 编号；一条都没有时为 `10`。
 */
function lastStepId(log: StepLog): string {
  return log.steps[log.steps.length - 1]?.id ?? '10'
}

/**
 * 注册入口路由。
 *
 * 单独导出而不是塞进构造函数，是为了让"注册是 effect"这一点留在调用处：
 * `apply` 里一次 `ctx.effect` 就同时管住注册与撤销。
 * @param deps - 运行期依赖。
 * @param readers - 读当前权威与入口开关。
 * @returns 释放路由的函数。
 */
export function mountEntryRoute(
  deps: RelayRuntimeDeps,
  readers: { authority: () => string; enabled: () => boolean },
): () => void {
  return registerEntryRoute({
    ctx: deps.ctx,
    webServer: deps.webServer,
    logger: deps.logger,
    logLabel: deps.config.logLabel,
    authority: readers.authority,
    enabled: readers.enabled,
  })
}
