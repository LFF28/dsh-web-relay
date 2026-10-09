/**
 * `ssh` 与 `ssh-keygen` 的参数构造，以及一次性远程命令的执行。
 *
 * 这是插件里唯一拼 `ssh` 命令的地方。集中在这里有一条实际理由：每一条连接都必须
 * 带同一组安全选项，分散到引导与预检两处时，最容易发生的是「新加的那条路径忘了
 * `StrictHostKeyChecking`」，而这种遗漏在测试里看不出来。
 * @module dsh-web-relay/ssh
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { controlSocketDir } from './paths.js'
import type { Deployment } from './deployment.js'

/**
 * `extraOptions` 不允许覆盖的选项。
 *
 * 这几项是安全与可用性的前提：`BatchMode` 与 `NumberOfPasswordPrompts` 保证进程
 * 不会挂在一个永远不来的输入上，`StrictHostKeyChecking` + `UserKnownHostsFile`
 * 保证连的是被核对过的那台机器，`ConnectTimeout` 保证失败有一个上界。
 */
const PROTECTED_OPTIONS = new Set([
  'batchmode',
  'stricthostkeychecking',
  'userknownhostsfile',
  'numberofpasswordprompts',
  'connecttimeout',
  'exitonforwardfailure',
  'identitiesonly',
  'loglevel',
  'controlmaster',
  'controlpath',
  'controlpersist',
])

/** 一次连接要用的全部身份与选项。 */
export interface SshTarget {
  /** 中继主机地址。 */
  readonly host: string
  /** SSH 端口。 */
  readonly port: number
  /** 登录账号。 */
  readonly user: string
  /** 私钥路径；留空表示走系统身份解析。 */
  readonly identityFile: string | undefined
  /** 本机专用的 `known_hosts` 绝对路径。 */
  readonly knownHostsFile: string
  /** 连接超时秒数。 */
  readonly connectTimeoutSec: number
  /**
   * `ControlPath` 模式（含 `%C`）；`undefined` 表示不复用连接。
   *
   * 给了它就走 ControlMaster 复用：第一条命令建立 master，其余命令骑同一条 TCP
   * 连接。这是给**引导**那种「十几条短命令」的路径用的；隧道是常驻的长连接，
   * 它有自己的重连退避，刻意不共用（见 `tunnel.ts`）。
   */
  readonly controlPath: string | undefined
  /** 追加的 `-o` 选项；键冲突时以插件自身的安全选项为准。 */
  readonly extraOptions: Readonly<Record<string, string>>
}

/**
 * 把一段文本包成单个 shell 词。
 *
 * 远程命令是通过登录 shell 执行的，所以任何来自配置或模板的片段在拼进命令行之前
 * 都要经过这里。单引号内部的单引号用 `'\''` 收尾再重开。
 * @param word - 原始文本。
 * @returns 可以安全放进命令行的单个词。
 */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * 组装所有 `ssh` 调用共享的连接选项。
 *
 * 返回值以可执行文件名开头、以 `user@host` 结尾；调用方在其后追加命令或转发参数。
 * @param target - 连接身份。
 * @param extra - 追加在连接选项之后的参数（例如 `-N` 或转发规格）。
 * @returns 完整的 argv。
 */
export function connectionArgv(target: SshTarget, extra: readonly string[] = []): string[] {
  const argv = [
    'ssh',
    ...extra,
    '-T',
    '-o', `UserKnownHostsFile=${target.knownHostsFile}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'LogLevel=ERROR',
    '-o', `ConnectTimeout=${target.connectTimeoutSec}`,
  ]
  if (target.controlPath !== undefined) {
    // `auto`：有 master 就骑上去，没有就顺手建一个。它也让**过期的** socket 文件
    // 不再致命——套接字还在但 master 已经死了时，`ssh` 会退回直连而不是报错。
    argv.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${target.controlPath}`,
      // 空闲 60 秒后 master 自行退出。一次引导的十几条命令集中在几十秒内跑完，
      // 60 秒足够覆盖整轮，又不留下长期存在的后台进程。
      '-o', 'ControlPersist=60',
    )
  }
  if (target.identityFile !== undefined) {
    argv.push('-o', 'IdentitiesOnly=yes', '-i', target.identityFile)
  }
  for (const [key, value] of Object.entries(target.extraOptions)) {
    // 键冲突时以插件自身的安全选项为准：先写的那一份才是生效的那一份。
    if (PROTECTED_OPTIONS.has(key.toLowerCase())) continue
    argv.push('-o', `${key}=${value}`)
  }
  argv.push('-p', String(target.port), `${target.user}@${target.host}`)
  return argv
}

/**
 * 组装一条远程命令的 argv。
 *
 * `command` 必须已经是**单个**参数：`ssh` 把 host 之后的所有参数用一个空格连起来
 * 交给远端，传多个词会让它们被重新分词。需要展开的片段请先用 {@link shellQuote}。
 * @param target - 连接身份。
 * @param command - 单独一个参数的远程命令。
 * @returns 完整的 argv。
 */
export function commandArgv(target: SshTarget, command: string): string[] {
  return [...connectionArgv(target), command]
}

/**
 * 管理连接的目标。
 *
 * `extraOptions` 固定为空：管理动作（引导、预检、观测）不吃隧道专用的那些选项，
 * 两边混在一处时，改隧道参数会悄悄改掉引导行为。
 *
 * `controlPath` 则相反——管理路径**默认**复用连接（见 {@link controlPathPattern}），
 * 因为引导要开十几条短连接。隧道不走这里，它自己拼目标。
 * @param deployment - 部署参数。
 * @param knownHostsFile - 本机专用 `known_hosts`。
 * @param connectTimeoutSec - 连接超时秒数。
 * @returns 可直接交给 {@link commandArgv} 的目标。
 */
export function adminTarget(deployment: Deployment, knownHostsFile: string, connectTimeoutSec: number): SshTarget {
  const pattern = controlPathPattern()
  return {
    host: deployment.host,
    port: deployment.sshPort,
    user: deployment.user,
    identityFile: deployment.identityFile,
    knownHostsFile,
    connectTimeoutSec,
    // 放不下就退回直连。检查放在这里而不是各个调用点：`$DSH_HOME` 很长时这是
    // 唯一能让「连不上」而不是「复用失败」的地方，漏一处就是全盘连接不可用。
    controlPath: controlPathFits(pattern) ? pattern : undefined,
    extraOptions: {},
  }
}

/**
 * 管理连接的 `ControlPath` 模式。
 *
 * 用 `%C` 而不是自己拼 `user@host:port`：`%C` 是「本机、远端、端口、账号」四者的
 * 短哈希，`ssh` 自己算，因此不同主机、不同账号**不会**撞进同一个 socket。管理账号
 * 与隧道的 `relay` 账号因此天然分属两个 socket，不需要额外约定；而且哈希里不含
 * 可读的主机名与账号，套接字文件名落盘时也不泄露连的是谁。
 *
 * 它不接 `deployment`：路径与账号无关，隔离交给 `%C`。要参数就得靠调用方记得传，
 * 而这里根本没有需要它的理由。
 * @returns 交给 `ControlPath` 的模式字符串。
 */
export function controlPathPattern(): string {
  return `${controlSocketDir()}/%C`
}

/**
 * 连接复用的收敛检查：`ControlPath` 是 unix 套接字路径，超过这个长度时 `ssh`
 * 拒绝启动，而且**是在连上之前**就拒绝，表现为所有连接一起失败。
 */
const CONTROL_PATH_LIMIT = 108

/**
 * 判断 `ControlPath` 展开后是否放得下。
 *
 * `%C` 展开成 40 个字符的哈希，所以这里按 40 算。放不下时调用方应当退回不复用，
 * 而不是让整台机器的连接一起坏掉：复用是优化，直连才是保底。
 * @param pattern - {@link controlPathPattern} 的返回值（尚未展开 `%C`）。
 * @returns 放得下时为 true。
 */
export function controlPathFits(pattern: string): boolean {
  return pattern.replace('%C', '0'.repeat(40)).length < CONTROL_PATH_LIMIT
}

/**
 * 按账号是否 root 决定远端命令要不要穿过 `sudo -n`。
 *
 * `-n` 是刻意的：免密就直接跑，需要口令就立刻以 `sudo: a password is required`
 * 失败，而不是挂在一个永远不来的输入上等超时。
 * @param user - 远端账号名。
 * @param command - 远程命令（需要展开的片段请先用 {@link shellQuote}）。
 * @returns 真正交给远端的命令。
 */
export function privilegedCommand(user: string, command: string): string {
  return user === 'root' ? command : `sudo -n ${command}`
}

/** 一次远程命令的结果。 */
export interface SshRunResult {
  /** 退出码；被信号终止时为 null。 */
  readonly exitCode: number | null
  /** stdout 全文（有界收集的尾部）。 */
  readonly stdout: string
  /** stderr 全文（有界收集的尾部）。 */
  readonly stderr: string
  /** 是否因超时被终止。 */
  readonly timedOut: boolean
}

/** 一次远程命令的规格。 */
export interface SshRunSpec {
  /** 完整 argv。 */
  readonly argv: readonly string[]
  /** 工作目录（子进程的 `cwd`，与远端无关）。 */
  readonly cwd: string
  /** 远程命令的 stdin；`undefined` 表示 `/dev/null`。 */
  readonly stdin?: string
  /** 总超时。 */
  readonly timeoutMs: number
  /** 超时后 `SIGTERM` 到 `SIGKILL` 的宽限。 */
  readonly graceMs: number
  /** 每个输出流保留的字节数。 */
  readonly maxOutputBytes?: number
  /** 外部取消信号。 */
  readonly signal?: AbortSignal
}

/**
 * 跑一条远程命令并收集结果。
 *
 * 输出用有界收集的**尾部**：`ssh` 的报错信息总在最后，而临时文件与 spill 都不需要。
 * @param subprocess - DSH 的子进程 seam。
 * @param spec - 命令规格。
 * @returns 退出码与两个输出流。
 */
export async function runSsh(subprocess: SubprocessRuntime, spec: SshRunSpec): Promise<SshRunResult> {
  const maxBytes = spec.maxOutputBytes ?? 16384
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, spec.timeoutMs)
  const onOuterAbort = (): void => { controller.abort() }
  spec.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const handle = subprocess.spawn({
      argv: [...spec.argv],
      cwd: spec.cwd,
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs: spec.graceMs,
      signal: controller.signal,
    })
    const outcome = await handle.done
    return {
      exitCode: outcome.exitCode,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      timedOut: controller.signal.aborted,
    }
  } finally {
    clearTimeout(timer)
    spec.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** 一台主机的一条公钥指纹。 */
export interface HostKeyFingerprint {
  /** `SHA256:…` 形式的指纹。 */
  readonly fingerprint: string
  /** 密钥类型，例如 `ED25519`。 */
  readonly type: string
}

/**
 * 解析 `ssh-keygen -lf <known_hosts>` 的输出。
 *
 * 输出形如 `256 SHA256:AAAA… 175.178.171.191 (ED25519)`；主机名位置由 ssh-keygen
 * 从 known_hosts 行首取出，因此同一台主机的多条密钥会给出多行。
 * @param output - `ssh-keygen -lf` 的 stdout。
 * @returns 每条密钥一条记录，解析不出的行被忽略。
 */
export function parseFingerprints(output: string): HostKeyFingerprint[] {
  const found: HostKeyFingerprint[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*\d+\s+(?<fp>SHA256:\S+)\s+\S+\s+\((?<type>[A-Za-z0-9-]+)\)\s*$/.exec(line)
    const fingerprint = match?.groups?.fp
    const type = match?.groups?.type
    if (fingerprint === undefined || type === undefined) continue
    found.push({ fingerprint, type })
  }
  return found
}

/**
 * 从一组指纹里挑出用于展示的那一条。
 *
 * 优先 ED25519：它最短、也是 `ssh-keyscan` 默认会拿到的现代算法。用户要核对的就是
 * 这一条，所以必须是确定的一条而不是「随便一条」。
 * @param fingerprints - {@link parseFingerprints} 的结果。
 * @returns 选中的指纹；输入为空时为 undefined。
 */
export function preferredFingerprint(fingerprints: readonly HostKeyFingerprint[]): HostKeyFingerprint | undefined {
  return fingerprints.find(item => item.type.toUpperCase() === 'ED25519') ?? fingerprints[0]
}

/**
 * 解析 `sshd` 交给登录 shell 的 `SSH_CONNECTION`，取出本端的公网出口地址。
 *
 * 形如 `183.48.247.66 52703 172.16.0.7 22`：第一个字段是客户端地址，也就是内网
 * 主机在这一跳上对外的地址。它是留给中继侧 `fail2ban` 的 `ignoreip` 的值——出口
 * 地址会变（换网络、运营商重新分配），所以在每次部署里现取，而不是让人手工填一个
 * 会过期的常量。
 *
 * 取不到时返回 undefined：这个值只用于放宽中继上的封禁，宁可让它继续按默认规则
 * 计数，也不让一个猜出来的地址进入过滤规则。
 * @param value - `SSH_CONNECTION` 的原文。
 * @returns IPv4/IPv6 字面量；没有有效值时 undefined。
 */
export function egressAddress(value: string | undefined): string | undefined {
  const candidate = (value ?? '').trim().split(/\s+/u)[0] ?? ''
  if (candidate === '') return undefined
  // `sshd` 只会填字面量地址，但仍要挡住从这里溜进配置文件的东西：fail2ban 的
  // `ignoreip` 是按空白分词的列表，一个带空格或注释符的值足以改写整行。
  return /^[0-9a-fA-F.:]+$/u.test(candidate) ? candidate : undefined
}

/**
 * 取输出的第一行非空内容。
 * @param text - 原始输出。
 * @returns 第一行；没有内容时为空串。
 */
export function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}
