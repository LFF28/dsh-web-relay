/**
 * 反向隧道的守护进程。
 *
 * 一条 `ssh -N -R` 把中继上的 `127.0.0.1:<relayPort>` 接到本机的 dsh web 端口。
 * 这个类只负责一件事：让那条连接在需要的时候是活的。它不认识引导、权威或入口，
 * 只认识「怎么起、怎么判断活着、断了怎么办、怎么收干净」。
 * @module dsh-web-relay/tunnel
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessRuntime, SubprocessStdio } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from './deployment.js'
import { connectionArgv, type SshTarget } from './ssh.js'

/** 隧道守护对外可见的状态。 */
export type TunnelState = 'stopped' | 'starting' | 'running' | 'backing-off'

/** 只用到日志接口的这三档，避免把整个 LoggerService 拉进来。 */
export type RelayLogger = Pick<Context['logger'], 'info' | 'warn' | 'error'>

/** 隧道的固定参数与依赖。 */
export interface TunnelDeps {
  /** DSH 的子进程 seam。 */
  readonly subprocess: SubprocessRuntime
  /** 日志。 */
  readonly logger: RelayLogger
  /** 子进程的工作目录。 */
  readonly cwd: string
  /** 中继上反向转发端点的端口。 */
  readonly relayPort: number
  /** 日志前缀。 */
  readonly logLabel: string
  /** 重连退避序列。 */
  readonly backoffMs: readonly number[]
  /** 子进程存活超过此时长才把退避重置到第一项。 */
  readonly healthyAfterMs: number
  /** 拆除的 `SIGTERM` 到 `SIGKILL` 宽限。 */
  readonly graceMs: number
  /** 追加的 `ssh -o` 选项。 */
  readonly extraOptions: Readonly<Record<string, string>>
  /** 连接超时秒数。 */
  readonly connectTimeoutSec: number
  /** 本机专用 `known_hosts`。 */
  readonly knownHostsFile: string
  /** 隧道专用私钥。 */
  readonly identityFile: string
  /** 本机 dsh web 的监听端口；每次连接前现取，因为端口可能由 OS 分配。 */
  dshPort(): number
  /** 每次连接前的转发前预检。 */
  beforeConnect(deployment: Deployment, signal: AbortSignal): Promise<void>
  /** 状态变化通知。 */
  onState(state: TunnelState): void
}

/**
 * 一条隧道的生命周期与重连。
 *
 * 状态机的三档对应三件不同的事：`starting` 是第一次连接，`backing-off` 是失败后的
 * 等待，`running` 是连接已经活了超过 `healthyAfterMs`。分开它们的理由是可诊断性——
 * 卡片上显示「正在重试（第 3 次）」比显示「未连接」有用得多。
 */
export class Tunnel {
  /** 每次 `start` 递增；循环用它判断自己是否已经被取代。 */
  #generation = 0
  /** 当前运行中的循环的取消信号。 */
  #abort: AbortController | undefined
  /** 当前连接开始的时间；没连接时为 undefined。 */
  #connectedSince: number | undefined
  /** 当前状态。 */
  #state: TunnelState = 'stopped'
  /** 已经过去的失败次数，决定下一段退避。 */
  #attempt = 0
  /** 当前那次尝试的进程句柄；`stop` 用它把进程真的收掉。 */
  #current: SubprocessHandle | undefined

  /**
   * @param deps - 固定参数与依赖。
   */
  constructor(private readonly deps: TunnelDeps) {}

  /**
   * 当前状态。
   * @returns 状态机当前所处的档位。
   */
  state(): TunnelState {
    return this.#state
  }

  /**
   * 本次连接已经活了多久。
   * @returns 毫秒数；当前没有连接时为 undefined。
   */
  uptimeMs(): number | undefined {
    return this.#connectedSince === undefined ? undefined : Date.now() - this.#connectedSince
  }

  /**
   * 指向新的目标：先收干净旧循环，再开始新循环。
   *
   * 收干净是硬要求。`ssh -R` 的转发端点是**服务端**持有的监听套接字：旧的 `ssh`
   * 还活着的时候新的那一条会以 `ExitOnForwardFailure` 失败。所以 `stop()` 必须等到
   * 进程真的不在了才返回，轮询的 `beforeConnect` 才有机会清掉残留。
   * @param deployment - 目标与身份。
   */
  async start(deployment: Deployment): Promise<void> {
    await this.stop()
    const generation = ++this.#generation
    const abort = new AbortController()
    this.#abort = abort
    this.#attempt = 0
    this.#setState('starting')
    void this.#loop(generation, deployment, abort.signal)
  }

  /**
   * 停止并把状态落回 `stopped`。
   *
   * 顺序是刻意的：先中断循环（这样它不会再起新连接），再终止子进程，最后等进程范围
   * **真的**空掉。等这一步是必须的——`ssh -R` 的转发端点在服务端，进程不在了端点才
   * 会释放，不等的直接后果是下一条连接以 `ExitOnForwardFailure` 失败。
   *
   * 等待带界：`waitForExit` 在提供者失去观测能力时会抛出，宽限也有上限，所以 `stop`
   * 不会挂在一个收不掉的进程上。
   */
  async stop(): Promise<void> {
    this.#generation += 1
    this.#abort?.abort()
    this.#abort = undefined
    const handle = this.#current
    if (handle !== undefined) {
      handle.terminate()
      await handle.waitForExit(this.#exitBound()).catch(() => false)
    }
    this.#connectedSince = undefined
    this.#setState('stopped')
  }

  /** 重连循环。退出条件只有两个：被 `stop` 取代，或进程被释放。 */
  async #loop(generation: number, deployment: Deployment, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && generation === this.#generation) {
      const attemptLabel = this.#attempt === 0 ? '' : `（第 ${String(this.#attempt)} 次重试）`
      const startedAt = Date.now()
      let failure: string | undefined
      try {
        this.deps.logger.info('%s 建立隧道 → 127.0.0.1:%d%s', this.deps.logLabel, this.deps.relayPort, attemptLabel)
        await this.deps.beforeConnect(deployment, signal)
        if (signal.aborted || generation !== this.#generation) return
        const healthy = setTimeout(() => {
          if (signal.aborted || generation !== this.#generation) return
          this.#connectedSince = startedAt
          this.#setState('running')
        }, this.deps.healthyAfterMs)
        try {
          failure = await this.#runOnce(deployment, signal)
        } finally {
          clearTimeout(healthy)
        }
      } catch (error) {
        failure = describe(error)
      }
      if (signal.aborted || generation !== this.#generation) return
      const lived = Date.now() - startedAt
      this.#connectedSince = undefined
      if (failure === undefined) {
        this.deps.logger.warn('%s 隧道断开（存活 %ds）', this.deps.logLabel, Math.round(lived / 1000))
      } else {
        this.deps.logger.warn('%s 隧道未建立：%s', this.deps.logLabel, failure)
      }
      // 活过健康阈值的连接算「真的连上过」，退避重新从第一项开始。
      if (lived >= this.deps.healthyAfterMs) this.#attempt = 0
      const delay = this.deps.backoffMs[Math.min(this.#attempt, this.deps.backoffMs.length - 1)] ?? 1000
      this.#attempt += 1
      this.#setState('backing-off')
      await sleep(delay, signal)
    }
  }

  /**
   * 起一条 `ssh -N -R` 并等它结束。
   * @returns 干净退出时为 undefined，否则是一行失败摘要。
   */
  async #runOnce(deployment: Deployment, signal: AbortSignal): Promise<string | undefined> {
    const target: SshTarget = {
      host: deployment.host,
      port: deployment.sshPort,
      user: 'relay',
      identityFile: this.deps.identityFile,
      knownHostsFile: this.deps.knownHostsFile,
      connectTimeoutSec: this.deps.connectTimeoutSec,
      extraOptions: this.deps.extraOptions,
    }
    const argv = connectionArgv(target, [
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'RequestTTY=no',
      '-R', `127.0.0.1:${String(this.deps.relayPort)}:127.0.0.1:${String(this.deps.dshPort())}`,
    ])
    const stdio: SubprocessStdio = {
      stdin: 'ignore',
      stdout: { maxBytes: 8192 },
      stderr: { maxBytes: 8192 },
    }
    const handle = this.deps.subprocess.spawn({
      argv,
      cwd: this.deps.cwd,
      stdio,
      graceMs: this.deps.graceMs,
      signal,
      // 指定了私钥就不要再让 agent 参与：转发进程不该有能力用别的钥匙开门。
      env: { SSH_AUTH_SOCK: undefined },
    })
    this.#current = handle
    try {
      // 等「进程范围空了」而不是只等 `done`。`done` 报的是命令自己的退出事实；真正
      // 决定中继侧端点有没有释放的是进程还在不在。只等 `done` 时一条不落定的 `done`
      // 会让循环永远停在 `running`——端口上什么都没有，卡片却显示已连接。
      const exited = await Promise.race([
        handle.done.then(outcome => ({ outcome })),
        handle.waitForExit().then(() => ({ outcome: undefined }), () => ({ outcome: undefined })),
      ])
      // 清掉 `#current` 之前先确认进程范围空了，这样「`#current` 有值」与「进程可能还在」
      // 始终等价，`stop` 才敢相信句柄。
      await handle.waitForExit(this.#exitBound()).catch(() => false)
      if (signal.aborted) return undefined
      if (exited.outcome?.exitCode === 0) return undefined
      const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
      const code = exited.outcome?.exitCode
      return `ssh ${code === undefined || code === null ? '已退出' : `退出码 ${String(code)}`}${stderr === '' ? '' : `：${stderr}`}`
    } finally {
      if (this.#current === handle) this.#current = undefined
    }
  }

  /** `waitForExit` 的等待上限：宽限之后再加一秒，超出就按「收不干净」继续。 */
  #exitBound(): AbortSignal {
    return AbortSignal.timeout(this.deps.graceMs + 1000)
  }

  /** 状态变化时通知外部，并跳过重复通知。 */
  #setState(state: TunnelState): void {
    if (this.#state === state) return
    this.#state = state
    this.deps.onState(state)
  }
}

/**
 * 可被取消的等待。
 * @param ms - 毫秒数。
 * @param signal - 取消信号；已取消时立即返回。
 * @returns 到点或取消时落定。
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 把任意抛出物压成一行可读文本。
 * @param error - 抛出物。
 * @returns 一行摘要。
 */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
