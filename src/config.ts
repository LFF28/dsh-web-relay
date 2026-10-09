/**
 * 插件配置的 schema：包内行为旋钮 + 用户填的部署参数。
 *
 * 两者写在同一个 `Config` 里，但生命周期不同：
 *
 * - 旋钮（`logLabel`、`tunnel`、`bootstrap`、`entry`、`selfCheck`）随
 *   `cordis.patch.yml` 发布，改了要重挂载，只由包作者动。
 * - `deployment` 是用户在设置页里填的部署参数，**整棵子树标了 volatile**：提交后就地
 *   换值、不重挂载，所以「点一次部署」不会把插件连同已经起来的隧道一起拆掉重建。
 *
 * 子树整体标 volatile 而不是逐字段标，是因为这两条约束合起来只剩这一个写法：
 * schemastery 拒绝 volatile 里再套 volatile，而 `SettingsForms.write` 只接受
 * volatile 路径。
 *
 * 运行记录**不在**这里：它是插件写的、体量随引导步骤增长的宿主状态，走插件自己的
 * `/api/web-relay.record` 通道，见 `record.ts`。
 *
 * 每一个字段都用 `.required()` 或 `.default(...)` 显式表态，不依赖 schema 库对
 * 「没写就是可选」的隐式约定。
 * @module dsh-web-relay/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
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
  /** 部署后的自检。 */
  selfCheck?: {
    /** 部署结束后是否真的去请求一次公网权威。 */
    publicProbe?: boolean
    /** 自检请求超时。 */
    probeTimeoutMs?: number
  }
  /**
   * 用户填的部署参数。整棵子树是 volatile 的，因此设置页可以在不重挂载插件的前提下
   * 编辑它。
   */
  deployment?: Volatile<DeploymentConfig>
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

/** 部署后的自检那一段的 schema。 */
const SelfCheckConfigSchema: z<NonNullable<RelayConfig['selfCheck']>> = z.object({
  publicProbe: z.boolean().default(true),
  probeTimeoutMs: z.natural().min(1).default(5000),
})

/** 用户在设置页里填的部署参数。 */
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
  /** 部署请求：用户点一次部署就把这两个值一起写下来。 */
  deploy?: {
    /**
     * 部署请求计数：每次点部署加一。
     *
     * 它存在的唯一理由是设置服务对解析后的值做深层相等短路：写入与现值相同时既不
     * 通知观察者也不推进修订号。没有它，"中继侧被手工改过、表单一个字没动、再点
     * 一次部署"会静默什么都不做。
     */
    request?: number
    /**
     * 这次部署是否要求随 DSH 启动自动部署。
     *
     * 它只是请求。真正决定启动时动不动手的是"记录里上次部署的结果是不是成功"：
     * 失败的部署会把记录写成 `failed`，这个开关因此自动失效，不需要第二个字段记账。
     */
    autoDeploy?: boolean
  }
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

/** 部署请求那一段的 schema。 */
const DeployRequestSchema: z<NonNullable<DeploymentConfig['deploy']>> = z.object({
  request: z.natural().default(0),
  autoDeploy: z.boolean().default(false),
})

/** {@link DeploymentConfig} 的 schema。 */
export const Deployment: z<DeploymentConfig> = z.object({
  vps: VpsSchema.default({}),
  gateway: GatewaySchema.default({}),
  deploy: DeployRequestSchema.default({}),
})

/**
 * {@link RelayConfig} 的 schema。
 *
 * 刻意**不**标注 `z<RelayConfig>`：`deployment` 是 volatile 的，schema 的输出类型
 * 是 `Volatile<DeploymentConfig>` 而不是 `DeploymentConfig`，两者对不上。仓库里
 * 另外两个带 volatile 字段的插件（`ui-theme`、`llm-pi-ai`）同样不标这个注解。
 *
 * `deployment` 的 `.volatile()` 标在整棵子树上：提交后 Loader 会把新值写进运行中
 * fiber 的这一个引用，并派发 `loader/volatile-update`，插件据此重跑部署。
 */
export const Config = z.object({
  logLabel: z.string().default('dsh-web-relay'),
  tunnel: TunnelConfigSchema.default({}),
  bootstrap: BootstrapConfigSchema.default({}),
  entry: EntryConfigSchema.default({}),
  selfCheck: SelfCheckConfigSchema.default({}),
  deployment: Deployment.default({}).volatile(),
})

/**
 * `deployment` 的交叉字段约束。
 *
 * 两条都在写入时拒绝，而不是存下一个会让围栏在运行期拒绝、或者让引导跑到一半才
 * 发现缺东西的值：
 *
 * - `vps.host` 形状非法时的表现是「手机打开是 403」，而用户手上没有任何线索指向
 *   那个多余的路径或空白。
 * - 填了地址却没有口令时配不出网关，引导会以一份空哈希结束。
 *
 * 挂载点是 `internal/config` 瀑布：volatile 提交与 `configEditor.edit` 都会先跑
 * 它，所以设置页写入与手工改 profile 补丁走的是同一条校验。
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
  /** 部署结束后是否真的去请求一次公网权威。 */
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
