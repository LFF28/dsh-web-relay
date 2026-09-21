/**
 * 三份配置的 schema。
 *
 * 它们写入者、生命周期与保密级别都不同，所以刻意不合并：
 *
 * - `RelayConfig` 是包内的行为旋钮，随 `cordis.patch.yml` 发布，全部带默认值。
 * - `web-relay` 是用户填的部署参数，落盘在 `$DSH_HOME/settings.yaml`（`0600`）。
 * - `web-relay-record` 是插件写的运行记录，用户只读。
 *
 * 每一个字段都用 `.required()` 或 `.default(...)` 显式表态，不依赖 schema 库对
 * 「没写就是可选」的隐式约定。
 * @module dsh-web-relay/config
 */

import z from '@deepseek-ai/schemastery'
import { isBareAuthority } from './authority.js'

/** 包内行为旋钮，随包发布。 */
export interface RelayConfig {
  /** 所有日志与启动横幅的前缀。 */
  logLabel?: string
  /** 隧道守护与转发前预检。 */
  tunnel?: {
    /** 中继上 loopback 反向转发端点的端口；必须与 `permitlisten`、Caddy 上游三处一致。 */
    relayPort?: number
    /** 重连退避序列，用尽后停在最后一项。 */
    backoffMs?: number[]
    /** 子进程存活超过此时长才把退避重置到第一项。 */
    healthyAfterMs?: number
    /** 拆除时先发 `SIGTERM` 再等这么久才 `SIGKILL`。 */
    graceMs?: number
    /** 追加给 `ssh` 的 `-o` 选项；键冲突时以插件自身的安全选项为准。 */
    extraOptions?: Record<string, string>
  }
  /** 引导步骤的超时。 */
  bootstrap?: {
    /** 单个引导步骤的总超时（含 `apt` 安装）。 */
    stepTimeoutMs?: number
    /** 引导里单条远程命令的超时。 */
    commandTimeoutMs?: number
    /** `ssh -o ConnectTimeout`。 */
    connectTimeoutSec?: number
  }
  /** 公网入口。 */
  entry?: {
    /** 关掉后 `/relay/enter` 只回一段说明；中继侧的改写与跳转不变。 */
    enabled?: boolean
  }
  /** 启动自检。 */
  selfCheck?: {
    /** 引导结束后是否真的去请求一次公网权威。 */
    publicProbe?: boolean
    /** 自检请求超时。 */
    probeTimeoutMs?: number
  }
}

/** {@link RelayConfig} 的 schema。 */
/**
 * 隧道那一段的 schema。
 *
 * 单独命名并标注成 `z<T>`：schemastery 的 `.default({})` 只对"已经宽化成普通对象
 * 类型"的 object schema 成立，直接内联时它要求默认值把每个键都写全。
 */
const TunnelConfigSchema: z<NonNullable<RelayConfig['tunnel']>> = z.object({
  relayPort: z.natural().min(1).max(65535).default(18080),
  backoffMs: z.array(z.natural().min(1)).default([1000, 2000, 5000, 15000, 30000]),
  healthyAfterMs: z.natural().default(10000),
  graceMs: z.natural().default(3000),
  extraOptions: z.dict(z.string()).default({}),
})

/** 引导超时那一段的 schema。 */
const BootstrapConfigSchema: z<NonNullable<RelayConfig['bootstrap']>> = z.object({
  stepTimeoutMs: z.natural().min(1).default(120000),
  commandTimeoutMs: z.natural().min(1).default(30000),
  connectTimeoutSec: z.natural().min(1).default(10),
})

/** 公网入口那一段的 schema。 */
const EntryConfigSchema: z<NonNullable<RelayConfig['entry']>> = z.object({
  enabled: z.boolean().default(true),
})

/** 启动自检那一段的 schema。 */
const SelfCheckConfigSchema: z<NonNullable<RelayConfig['selfCheck']>> = z.object({
  publicProbe: z.boolean().default(true),
  probeTimeoutMs: z.natural().min(1).default(5000),
})

/** {@link RelayConfig} 的 schema。 */
export const Config: z<RelayConfig> = z.object({
  logLabel: z.string().default('dsh-web-relay'),
  tunnel: TunnelConfigSchema.default({}),
  bootstrap: BootstrapConfigSchema.default({}),
  entry: EntryConfigSchema.default({}),
  selfCheck: SelfCheckConfigSchema.default({}),
})

/** 用户在设置卡片里填的部署参数。 */
export interface DeploymentConfig {
  /** 中继主机。 */
  vps?: {
    /** 中继主机地址（IP 或主机名）。为空时插件只做本地准备，不引导。 */
    host?: string
    /** 管理连接的 SSH 端口。 */
    port?: number
    /** 管理账号：引导的提权步骤与转发前预检都用它。非 `root` 时调用 `sudo -n`，该账号必须免密 sudo。 */
    user?: string
    /** 管理账号私钥路径。留空则用系统身份解析（`~/.ssh/config`、默认私钥、`SSH_AUTH_SOCK`）。 */
    identityFile?: string
    /** 期望的中继主机公钥指纹，`SHA256:…` 形式。留空时首次连接按 TOFU 记录并打印。 */
    hostKeyFingerprint?: string
  }
  /** 公网入口。 */
  gateway?: {
    /** 公网入口 HTTPS 端口，也是中继上唯一的 HTTP 端口。 */
    port?: number
    /** 网关口令。必填，每次部署都要重填——它的值不回传浏览器。只交给中继上 `caddy hash-password` 的 stdin，明文不落中继的磁盘。 */
    password?: string
  }
  /** 隧道。 */
  tunnel?: {
    /** 引导与部署完成后是否维持隧道。 */
    autoStart?: boolean
  }
  /**
   * 部署请求计数。用户在设置页点一次部署就加一。
   *
   * 它存在的唯一理由是设置服务对解析后的值做深层相等短路：写入与现值相同时既不
   * 通知观察者也不推进修订号。没有它，"中继侧被手工改过、表单一个字没动、再点
   * 一次部署"会静默什么都不做。
   */
  bootstrapRequest?: number
}

/** {@link DeploymentConfig} 的 schema。 */
/** `vps` 那一段的 schema。 */
const VpsSchema: z<NonNullable<DeploymentConfig['vps']>> = z.object({
  host: z.string().default(''),
  port: z.natural().min(1).max(65535).default(22),
  user: z.string().default('root'),
  identityFile: z.string().default(''),
  hostKeyFingerprint: z.string().default(''),
})

/** `gateway` 那一段的 schema。 */
const GatewaySchema: z<NonNullable<DeploymentConfig['gateway']>> = z.object({
  port: z.natural().min(1).max(65535).default(8443),
  password: z.string().role('secret').default(''),
})

/** 部署侧隧道开关的 schema。 */
const DeploymentTunnelSchema: z<NonNullable<DeploymentConfig['tunnel']>> = z.object({
  autoStart: z.boolean().default(true),
})

/** {@link DeploymentConfig} 的 schema。 */
export const Deployment: z<DeploymentConfig> = z.object({
  vps: VpsSchema.default({}),
  gateway: GatewaySchema.default({}),
  tunnel: DeploymentTunnelSchema.default({}),
  bootstrapRequest: z.natural().default(0),
})

/** 引导一步的结果。 */
export interface BootstrapStep {
  /** 步骤 id，与 `docs/modules/bootstrap.md` 的编号一致。 */
  id: string
  /** 步骤标题。 */
  title: string
  /** `ok` 完成、`failed` 硬失败、`skipped` 因前一步失败而未执行。 */
  status: 'ok' | 'failed' | 'skipped'
  /** 一句话说明；失败时带远程命令的原文摘要。 */
  detail: string
}

/** 插件写给卡片看的运行记录。 */
export interface RecordConfig {
  /** 引导与隧道的合并状态。 */
  state?: 'unconfigured' | 'bootstrapping' | 'ready' | 'failed'
  /** 最近一次记录更新的 ISO 时间。 */
  updatedAt?: string
  /** 已生效的权威；空字符串表示尚未生效。 */
  publicAuthority?: string
  /** 首次连接时实地观察到（或按固定值校验通过）的中继主机公钥指纹。 */
  observedHostKeyFingerprint?: string
  /** 中继 CA 根证书的 `SHA256:…` 指纹。 */
  caFingerprint?: string
  /** 网关。 */
  gateway?: {
    /** 网关会话 Cookie 的比对值；`gateway.password` 每次变化时重新生成。 */
    sessionSecret?: string
  }
  /** 最近一次引导的逐步结果。 */
  steps?: BootstrapStep[]
  /** 最近一次失败的原文摘要，成功时为空。 */
  lastError?: string
  /** 最近一次转发前预检的结果。 */
  lastPreflight?: {
    /** `free` 空闲、`released` 清掉了残留、`skipped` 预检没跑成、`refused` 被占但不是本部署的残留。 */
    outcome: 'free' | 'released' | 'skipped' | 'refused'
    /** `skipped` 与 `refused` 的原因原文。 */
    message: string
  }
}

/** {@link RecordConfig} 的 schema。 */
const RecordGatewaySchema: z<NonNullable<RecordConfig['gateway']>> = z.object({
  sessionSecret: z.string().role('secret').default(''),
})

const RecordPreflightSchema: z<NonNullable<RecordConfig['lastPreflight']>> = z.object({
  outcome: z.union([
    z.const('free'), z.const('released'), z.const('skipped'), z.const('refused'),
  ]).required(),
  message: z.string().default(''),
})

/** {@link RecordConfig} 的 schema。 */
export const Record: z<RecordConfig> = z.object({
  state: z.union([
    z.const('unconfigured'), z.const('bootstrapping'), z.const('ready'), z.const('failed'),
  ]).default('unconfigured'),
  updatedAt: z.string().default(''),
  publicAuthority: z.string().default(''),
  observedHostKeyFingerprint: z.string().default(''),
  caFingerprint: z.string().default(''),
  gateway: RecordGatewaySchema.default({}),
  steps: z.array(z.object({
    id: z.string().required(),
    title: z.string().required(),
    status: z.union([z.const('ok'), z.const('failed'), z.const('skipped')]).required(),
    detail: z.string().required(),
  })).default([]),
  lastError: z.string().default(''),
  lastPreflight: RecordPreflightSchema.default({ outcome: 'free', message: '' }),
  tunnelState: z.union([
    z.const('stopped'), z.const('starting'), z.const('running'), z.const('backing-off'),
  ]).default('stopped'),
})

/**
 * `web-relay` 命名空间的交叉字段约束。
 *
 * 两条都在写入时拒绝，而不是存下一个会让围栏在运行期拒绝、或者让引导跑到一半才
 * 发现缺东西的值：
 *
 * - `vps.host` 形状非法时的表现是「手机打开是 403」，而用户手上没有任何线索指向
 *   那个多余的路径或空白。
 * - 填了地址却没有口令时配不出网关，引导会以一份空哈希结束。
 * @param value - 待写入的整节。
 * @throws {Error} 地址非空且不是裸的规范权威，或地址非空而口令为空时。
 */
export function validateDeployment(value: DeploymentConfig): void {
  const host = value.vps?.host ?? ''
  if (host === '') return
  if (!isBareAuthority(host)) {
    throw new Error(`vps.host 必须是裸的 host[:port]（不能带 scheme、路径、用户名或首尾空白）：${JSON.stringify(host)}`)
  }
  if ((value.gateway?.password ?? '') === '') {
    throw new Error('gateway.password 不能为空：网关口令不回传浏览器，每次部署都要重新填一次')
  }
}

/** 每一档都填好值的 {@link RelayConfig}，下游不再需要判空。 */
export interface ResolvedRelayConfig {
  /** 日志前缀。 */
  readonly logLabel: string
  /** 中继上反向转发端点的端口。 */
  readonly relayPort: number
  /** 重连退避序列。 */
  readonly backoffMs: readonly number[]
  /** 子进程存活超过此时长才把退避重置到第一项。 */
  readonly healthyAfterMs: number
  /** 拆除的 `SIGTERM` 到 `SIGKILL` 宽限。 */
  readonly graceMs: number
  /** 追加给 `ssh` 的 `-o` 选项。 */
  readonly extraOptions: Readonly<Record<string, string>>
  /** 单个引导步骤的总超时。 */
  readonly stepTimeoutMs: number
  /** 单条远程命令的超时。 */
  readonly commandTimeoutMs: number
  /** `ssh -o ConnectTimeout`。 */
  readonly connectTimeoutSec: number
  /** `/relay/enter` 是否答一套会话，还是只回"入口已关闭"。 */
  readonly entryEnabled: boolean
  /** 引导结束后是否真的去请求一次公网权威。 */
  readonly publicProbe: boolean
  /** 自检请求超时。 */
  readonly probeTimeoutMs: number
}

/**
 * 把 Loader 解析过的配置补齐。
 *
 * schema 默认值通常已经生效，但手工搭的上下文可能一份都没传；这里再兜一次，
 * 让下游只面对一个所有字段都有值的结构。
 * @param raw - Loader 交来的配置，可能为空。
 * @returns 填满的配置。
 */
export function resolveRelayConfig(raw: RelayConfig | undefined): ResolvedRelayConfig {
  return {
    logLabel: raw?.logLabel ?? 'dsh-web-relay',
    relayPort: raw?.tunnel?.relayPort ?? 18080,
    backoffMs: raw?.tunnel?.backoffMs ?? [1000, 2000, 5000, 15000, 30000],
    healthyAfterMs: raw?.tunnel?.healthyAfterMs ?? 10000,
    graceMs: raw?.tunnel?.graceMs ?? 3000,
    extraOptions: raw?.tunnel?.extraOptions ?? {},
    stepTimeoutMs: raw?.bootstrap?.stepTimeoutMs ?? 120000,
    commandTimeoutMs: raw?.bootstrap?.commandTimeoutMs ?? 30000,
    connectTimeoutSec: raw?.bootstrap?.connectTimeoutSec ?? 10,
    entryEnabled: raw?.entry?.enabled ?? true,
    publicProbe: raw?.selfCheck?.publicProbe ?? true,
    probeTimeoutMs: raw?.selfCheck?.probeTimeoutMs ?? 5000,
  }
}
