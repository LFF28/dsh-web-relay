/**
 * 转发前预检：在起隧道之前，把中继上属于**本部署**的残留监听清掉。
 *
 * 为什么需要它：`ssh -R` 的转发端点是服务端持有的监听套接字。客户端异常消失时
 * （手机关屏、休眠、网络中断），对端可能等上很久才发现连接已死，这段时间里那个
 * 套接字还在 `LISTEN`。新起的隧道于是以 `ExitOnForwardFailure` 失败，而用户看到
 * 的只是「连不上」。
 *
 * 边界同样重要：预检只清理它认得出的残留，判据是「持有者是属主为 `relay` 的 sshd
 * 进程」——本部署刚刚留下的那种进程的形状，而不是「占用这个端口的任何东西」。
 * 当前那条连接还活着时预检根本不会被调用：`Tunnel.stop()` 已经先等它退出了。
 * @module dsh-web-relay/preflight
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from './deployment.js'
import { adminTarget, commandArgv, firstLine, privilegedCommand, runSsh, shellQuote, type SshTarget } from './ssh.js'
import type { RelayLogger } from './tunnel.js'

/** 最近一次预检的结果。 */
export interface PreflightOutcome {
  /** `free` 空闲、`released` 清掉了残留、`skipped` 预检没跑成、`refused` 被占但不是本部署的残留。 */
  readonly outcome: 'free' | 'released' | 'skipped' | 'refused'
  /** 说明文字；`free` 之外都带原因。 */
  readonly message: string
}

/** 预检的依赖。 */
export interface PreflightDeps {
  /** DSH 的子进程 seam。 */
  readonly subprocess: SubprocessRuntime
  /** 日志。 */
  readonly logger: RelayLogger
  /** 子进程的工作目录。 */
  readonly cwd: string
  /** 日志前缀。 */
  readonly logLabel: string
  /** 本机专用 `known_hosts`。 */
  readonly knownHostsFile: string
  /** 连接超时秒数。 */
  readonly connectTimeoutSec: number
  /** 单条远程命令的超时。 */
  readonly commandTimeoutMs: number
  /** 拆除宽限。 */
  readonly graceMs: number
}

/**
 * 判定并清理中继上的残留监听。
 *
 * 顺序固定：先**不带**特权地问一次端口（常见路径是空闲，所以普通情况下这段代码
 * 根本不碰 `sudo`），被占时才提权取持有者并核对身份，核对通过才动手。任何一步
 * 出错都只记录并返回——预检是修复，不是一道门。
 */
export class Preflight {
  /**
   * @param deps - 依赖。
   */
  constructor(private readonly deps: PreflightDeps) {}

  /**
   * 跑一次预检。
   * @param deployment - 中继地址与管理账号。
   * @param relayPort - 要检查的端口。
   * @param signal - 取消信号；已取消时立刻返回 `skipped`。
   * @returns 结果；本方法不抛出。
   */
  async run(deployment: Deployment, relayPort: number, signal: AbortSignal): Promise<PreflightOutcome> {
    if (signal.aborted) return { outcome: 'skipped', message: '已取消' }
    const target = this.#target(deployment)
    try {
      const probe = await runSsh(this.deps.subprocess, {
        argv: commandArgv(target, privilegedCommand(deployment.user, `ss -ltnH ${shellQuote(`sport = :${String(relayPort)}`)}`)),
        cwd: this.deps.cwd,
        timeoutMs: this.deps.commandTimeoutMs,
        graceMs: this.deps.graceMs,
        signal,
      })
      if (probe.exitCode !== 0) {
        return { outcome: 'skipped', message: `查端口失败：${firstLine(probe.stderr) || `退出码 ${String(probe.exitCode)}`}` }
      }
      if (probe.stdout.trim() === '') return { outcome: 'free', message: '' }

      const verdict = await runSsh(this.deps.subprocess, {
        argv: commandArgv(target, privilegedCommand(deployment.user, 'sh -s')),
        cwd: this.deps.cwd,
        stdin: inspectScript(relayPort),
        timeoutMs: this.deps.commandTimeoutMs,
        graceMs: this.deps.graceMs,
        signal,
      })
      if (verdict.exitCode !== 0) {
        return { outcome: 'skipped', message: `预检脚本失败：${firstLine(verdict.stderr) || `退出码 ${String(verdict.exitCode)}`}` }
      }
      const line = firstLine(verdict.stdout)
      if (line === 'FREE') return { outcome: 'free', message: '' }
      if (line === 'RELEASED') {
        this.deps.logger.warn('%s 转发前预检：清掉了 127.0.0.1:%d 上的残留监听，由属主 relay 的 sshd 进程持有', this.deps.logLabel, relayPort)
        return { outcome: 'released', message: '残留监听由属主 relay 的 sshd 进程持有，已清理' }
      }
      const reason = line.startsWith('REFUSED') ? line.slice('REFUSED'.length).trim() : line
      this.deps.logger.warn('%s 转发前预检：127.0.0.1:%d 被占用但不是本部署的残留，不动手（%s）', this.deps.logLabel, relayPort, reason)
      return { outcome: 'refused', message: reason }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.warn('%s 转发前预检未完成：%s', this.deps.logLabel, message)
      return { outcome: 'skipped', message }
    }
  }

  /** 管理连接的身份；预检不吃 `extraOptions`。 */
  #target(deployment: Deployment): SshTarget {
    return adminTarget(deployment, this.deps.knownHostsFile, this.deps.connectTimeoutSec)
  }
}

/**
 * 远端检查脚本。
 *
 * 全程只输出一行，退出码恒为 0——「端口被别人占着」是一个结论，不是错误。
 * @param relayPort - 要检查的端口。
 * @returns 脚本全文。
 */
function inspectScript(relayPort: number): string {
  return [
    'set -eu',
    `port=${shellQuote(String(relayPort))}`,
    'lines=$(ss -ltnpH "sport = :$port" 2>/dev/null || true)',
    'if [ -z "$lines" ]; then echo FREE; exit 0; fi',
    'relay_uid=$(getent passwd relay | cut -d: -f3 || true)',
    'if [ -z "$relay_uid" ]; then echo "REFUSED 中继上还没有 relay 账号"; exit 0; fi',
    'pids=$(printf \'%s\\n\' "$lines" | grep -o \'pid=[0-9]*\' | cut -d= -f2 | sort -u || true)',
    'if [ -z "$pids" ]; then echo "REFUSED 端口被占用但查不到持有进程"; exit 0; fi',
    'for pid in $pids; do',
    '  exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)',
    '  base=${exe##*/}',
    '  case "$base" in',
    '    sshd|sshd-session) ;;',
    '    *) echo "REFUSED pid $pid 的可执行文件是 ${exe:-读不到}，不是 sshd"; exit 0 ;;',
    '  esac',
    '  uid=$(stat -c %u "/proc/$pid" 2>/dev/null || true)',
    '  if [ "$uid" != "$relay_uid" ]; then echo "REFUSED pid $pid 属主 uid ${uid:-未知} 不是 relay($relay_uid)"; exit 0; fi',
    'done',
    'kill $pids 2>/dev/null || true',
    'i=0',
    'while [ $i -lt 20 ]; do',
    '  if ! ss -ltnH "sport = :$port" | grep -q .; then echo RELEASED; exit 0; fi',
    '  sleep 0.1',
    '  i=$((i + 1))',
    'done',
    'echo "REFUSED 已发出信号但端口在 2 秒内没有释放"',
    'exit 0',
    '',
  ].join('\n')
}
