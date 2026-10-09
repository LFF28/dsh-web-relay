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
import { isRunnable, type Deployment } from './deployment.js'
import { registerEntryRoute } from './entry.js'
import { caCert, knownHosts, relayPrivateKey, relayPublicKey, relayRoot, sshDir } from './paths.js'
import { Preflight, type PreflightOutcome } from './preflight.js'
import { readRecord, recordView, writeRecord, type RecordConfig, type RecordView } from './record.js'
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
  /**
   * 当前运行记录的浏览器视图。
   *
   * 走服务面而不是让路由直接读文件：内存里那一份才是权威，刚写完的记录立刻可见，
   * 不需要等一次磁盘往返。
   * @returns 剔除敏感字段后的记录。
   */
  record(): RecordView
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
 * 它把三件互相独立的事接在一起：一次设置写入请求一次部署，引导与隧道执行动作，
 * 记录把结果交回设置页。两条入口互不重叠——{@link RelayRuntime.start} 只恢复
 * 已经就绪的服务，只有设置提交才会重新配置中继。
 */
export class RelayRuntime {
  /** 交给 `ctx.provide` 的服务面。 */
  readonly handle: WebRelayHandle
  readonly #settings: RelaySettings
  readonly #tunnel: Tunnel
  readonly #preflight: Preflight
  readonly #trust: Trust
  readonly #bootstrap: Bootstrap
  /** 当前状态。 */
  #state: RelayState = 'unconfigured'
  /** 最近一次失败。 */
  #lastError = ''
  /** 最近一次预检。 */
  #lastPreflight: PreflightOutcome | undefined
  /** 网关会话密钥。 */
  #sessionSecret = ''
  /**
   * 内存里的记录副本。
   *
   * 记录同时落盘（`record.json`），但读路径不走文件：设置页每次打开都会取一次，
   * 隧道状态变化时也写一次，全部走磁盘既慢又会让"刚写进去的值"与"读出来的值"
   * 之间出现一个窗口。文件只用于跨重启恢复。
   */
  #record: RecordConfig = {}
  /** 部署串行队列；见 {@link RelayRuntime.deploy}。 */
  #queue: Promise<void> = Promise.resolve()

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
        await this.#patchRecord({ lastPreflight: this.#lastPreflight })
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
    // 服务面的两个取值器都从设置里现取：`connection` 行的 `!!js` 表达式在重解析时
    // 才求值，所以权威变化之后只要再触发一次重解析就够了，插件不持有第二份副本。
    const settingsFacade = this.#settings
    this.handle = {
      get trustedHosts(): readonly string[] {
        const authority = thisAuthorityOf(settingsFacade)
        return authority === '' ? [] : [authority]
      },
      authority: () => thisAuthorityOf(settingsFacade),
      status: () => this.#status(),
      record: () => recordView(this.#record),
    }
  }

  /**
   * 启动：建目录、备好会话密钥、读一次记录恢复内存状态，然后注册围栏、按设置
   * 决定要不要自动部署。
   *
   * 必须在 `apply` 里同步完成目录准备与路由注册，因此这里只把耗时的动作留成后台
   * 任务——`connection` 行不依赖它，它只依赖服务面已经 provide。
   */
  async start(): Promise<void> {
    await mkdir(sshDir(), { recursive: true, mode: 0o700 })
    this.#record = await readRecord()
    this.#sessionSecret = await this.#ensureSessionSecret()
    this.#state = this.#record.state ?? 'unconfigured'
    this.#lastError = this.#record.lastError ?? ''
    this.#lastPreflight = this.#record.lastPreflight
    // `tunnelState` 描述的是一个**活着的子进程**，而子进程从不跨重启存活：上一次
    // 运行留下 `running` 时，这个进程里其实一条隧道都没有。启动时因此无条件把它按
    // 事实写成 `stopped`——不写的话，设置页会一直显示"已连接"，而公网入口回的是
    // 502，两者互相矛盾且都以状态区为准。
    if (this.#record.tunnelState !== undefined && this.#record.tunnelState !== 'stopped') {
      await this.#patchRecord({ tunnelState: 'stopped' })
    }
    void this.#restore()
  }

  /**
   * 请求一次部署。
   *
   * 触发点是 `loader/volatile-update`：用户在设置页点一次部署就是一次 volatile 提交，
   * 之后 `deployment` 引用里已经是新值，这里直接读它就够了。
   *
   * 调用**串行排队**：提交可能连着来，而两次引导同时在同一条隧道上动手会互相拆台。
   * 排队的是整个部署而不是每个步骤，所以后一次提交看到的一定是前一次跑完之后的世界。
   * @returns 落定于本次部署结束。
   */
  deploy(): Promise<void> {
    this.#queue = this.#queue.then(() => this.#deploy(), () => this.#deploy())
    return this.#queue
  }

  /**
   * 启动：把当前权威注册进围栏，并在设置要求时自动跑一次部署。
   *
   * 只有"上次部署成功"与"这次部署要求随启动自动部署"同时成立才动手：失败的部署会
   * 把记录写成 `failed`，这个开关因此自动失效，不需要第二个字段记账。一次启动只
   * 尝试一次——引导失败就停在失败上，不重试。
   *
   * 不动手时补一次回环自检：权威必须已经在围栏里，否则这台机器配好了也会 403，而
   * 那行结论是"手机为什么打不开"的第一手信息。自动部署那条路不需要它——部署第 11
   * 步本来就要做一次同样的自检。
   * @returns 落定于本次启动动作结束。
   */
  async #restore(): Promise<void> {
    const deployment = this.#settings.deployment()
    this.#trust.apply()
    if (this.#record.state === 'ready' && deployment.autoDeploy) {
      this.deps.logger.info('%s 已打开随启动自动部署，开始自动部署', this.deps.config.logLabel)
      try {
        await this.#deploy()
      } catch (error) {
        // 引导自己把失败写进记录并返回，能走到这里的只有记录写入一类的意外。报出来，
        // 但绝不重试——下一次动手要么是重启，要么是用户在设置页点一次部署。
        this.deps.logger.error('%s 自动部署中断：%s', this.deps.config.logLabel, describeError(error))
      }
      return
    }
    if (deployment.authority === undefined) return
    const check = await this.#trust.selfCheck(
      deployment.authority, this.deps.webServer.port, this.deps.config.probeTimeoutMs,
    )
    this.deps.logger[check.ok ? 'info' : 'warn']('%s %s', this.deps.config.logLabel, check.detail)
  }

  /**
   * 一次部署：按当前设置跑完整引导。
   *
   * 只有 `loader/volatile-update` 会走到这里——用户在设置页点一次部署、或者手工改
   * profile 补丁里的 `deployment`，都是同一次 volatile 提交，因此两条路等效。
   * 调用方是 {@link RelayRuntime.deploy} 的串行队列，所以两次部署不会并发。
   * @returns 落定于本次引导结束。
   */
  async #deploy(): Promise<void> {
    const deployment = this.#settings.deployment()
    if (!isRunnable(deployment)) {
      await this.#tunnel.stop()
      this.#state = 'unconfigured'
      await this.#patchRecord({ state: 'unconfigured', publicAuthority: '' })
      return
    }
    await this.#doBootstrap(deployment)
  }

  /** {@link RelayRuntime.#deploy} 的实现；完整引导的第 0–13 步。 */
  async #doBootstrap(deployment: Deployment): Promise<void> {
    const label = this.deps.config.logLabel
    // 口令必填且浏览器拿不回它，所以每次部署都要重填一次；每一次部署都按"口令变了"
    // 处理：bcrypt 哈希与会话密钥一起换新，旧的网关会话一律失效。
    this.#sessionSecret = await this.#ensureSessionSecret(true)
    this.#state = 'bootstrapping'
    this.#lastError = ''
    const log = new StepLog()
    await this.#patchRecord({
      state: 'bootstrapping', steps: [], lastError: '',
    })
    this.deps.logger.info('%s 开始引导 %s@%s', label, deployment.user, deployment.host)

    const outcome = await this.#bootstrap.run(deployment, log, new AbortController().signal)

    if (!outcome.ok) {
      log.skipAfter(lastStepId(log), outcome.error ?? '引导失败')
      this.#state = 'failed'
      this.#lastError = outcome.error ?? '引导失败'
      await this.#patchRecord({
        state: 'failed',
        steps: [...log.steps],
        lastError: this.#lastError,
        observedHostKeyFingerprint: outcome.hostKeyFingerprint,
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
    await this.#patchRecord({
      state: this.#state,
      publicAuthority: authority,
      observedHostKeyFingerprint: outcome.hostKeyFingerprint,
      caFingerprint,
      caPem: outcome.caPem,
      gateway: { sessionSecret: this.#sessionSecret },
      steps: [...log.steps],
      lastError: this.#lastError,
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
      + `${ok ? '' : '（有步骤失败，详见设置 ▸ 远程访问）'}`
      + `\n  根证书指纹 ${caFingerprint}`
      + `\n  中继主机密钥 ${deployment.hostKeyFingerprint ?? '（未固定，见设置页的状态区）'}`
      + `\n  Caddy ${caddyVersion === '' ? '沿用已有安装' : caddyVersion}`)
    this.deps.logger.info('%s 引导结束：%s', label, ok ? '就绪' : this.#lastError)
  }

  /** 隧道状态变化时写回记录，供设置页显示。 */
  #onTunnelState(state: TunnelState): void {
    void this.#patchRecord({ tunnelState: state }).catch((error: unknown) => {
      this.deps.logger.warn('%s 写入隧道状态失败：%s', this.deps.config.logLabel, describeError(error))
    })
    this.deps.logger.info('%s 隧道状态：%s', this.deps.config.logLabel, state)
  }

  /**
   * 合并式写入记录。
   *
   * 内存副本先落定、再落盘：设置页读的是内存那一份，所以即使磁盘写失败，界面显示
   * 的也仍是刚刚发生的真实状态。写失败只记一行日志——记录是观测结果，它写不下去
   * 不该让一次正在进行的引导失败。
   * @param patch - 要覆盖的字段。
   * @returns 落定于落盘尝试结束。
   */
  async #patchRecord(patch: RecordConfig): Promise<void> {
    this.#record = { ...this.#record, ...patch, updatedAt: new Date().toISOString() }
    try {
      await writeRecord(patch, this.#record)
    } catch (error) {
      this.deps.logger.warn('%s 运行记录落盘失败：%s', this.deps.config.logLabel, describeError(error))
    }
  }

  /**
   * 读或生成网关会话密钥。
   * @param regenerate - 为 true 时无条件生成新的。
   * @returns 会话密钥。
   */
  async #ensureSessionSecret(regenerate = false): Promise<string> {
    const existing = this.#record.gateway?.sessionSecret ?? ''
    if (!regenerate && existing !== '') return existing
    const secret = randomBytes(24).toString('base64url')
    await this.#patchRecord({ gateway: { sessionSecret: secret } })
    return secret
  }

  /** 当前状态快照。 */
  #status(): RelayStatus {
    return {
      state: this.#state,
      authority: thisAuthorityOf(this.#settings),
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
