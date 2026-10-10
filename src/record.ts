/**
 * 插件的运行记录：插件写、设置页只读的宿主状态。
 *
 * 它不再是一个设置命名空间，原因有两个：
 *
 * - 记录由插件写、体量随引导步骤增长，而设置表单是「用户在配置里填的值」，两者
 *   混在一个文档里会让「用户清空一个字段」与「插件更新一次记录」互相覆盖。
 * - 0.2 的设置文档只接受 volatile 字段的写入，而记录是宿主状态，本来就不该由用户
 *   通过配置文档改写。
 *
 * 因此它落成一个 `$DSH_HOME/dsh-web-relay/record.json`（`0600`）文件，经
 * `/api/web-relay.record` 出去。那条路径挂在 DSH 共享 API 通道下，因此在
 * `connection` 的信任与认证围栏之后——公网上的中继只能把它转发给已经通过网关与
 * DSH 认证的浏览器。
 *
 * {@link recordView} 是唯一的出口，且**逐字段白名单**：记录里的
 * `gateway.sessionSecret` 不再有 schema 遮蔽兜底，必须由这里显式剔除。
 * @module dsh-web-relay/record
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { relayRoot } from './paths.js'

/** 引导一步的结果。 */
export interface BootstrapStep {
  /** 步骤 id，与 `docs/internals/bootstrap.md` 的编号一致。 */
  id: string
  /** 步骤标题。 */
  title: string
  /** `ok` 完成、`failed` 硬失败、`skipped` 因前一步失败而未执行。 */
  status: 'ok' | 'failed' | 'skipped'
  /** 一句话说明；失败时带远程命令的原文摘要。 */
  detail: string
}

/** 插件写下的运行记录。 */
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
  /**
   * 中继 CA 根证书的 PEM 全文，供设置页存成本地文件。
   *
   * 它只有公钥材料，本来就要装到设备上，所以刻意**不**剔除：要原样送到设置页，
   * 那里才有东西可下载。约 810 字节 base64。读它的前提是已经过了网关口令与 DSH
   * 认证，而且这个标签页只在 loopback 上注册。
   */
  caPem?: string
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
  /** 隧道最近一次对外可见的状态。 */
  tunnelState?: 'stopped' | 'starting' | 'running' | 'backing-off'
}

/** {@link RecordConfig} 的 schema；调用它即补齐全部缺省字段。 */
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
  caPem: z.string().default(''),
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
 * 记录文件的位置。
 * @returns `$DSH_HOME/dsh-web-relay/record.json`。
 */
export function recordFile(): string {
  return `${relayRoot()}/record.json`
}

/**
 * 读记录。
 *
 * 一个读不出来的文件（首次启动、手工删掉、半截的 JSON）一律当成空记录：记录是
 * 观测结果而不是配置，读不到只该让状态区显得"还没部署"，不该让插件启动失败。
 * @returns 补齐缺省字段后的记录。
 */
export async function readRecord(): Promise<RecordConfig> {
  let raw: string
  try {
    raw = await readFile(recordFile(), 'utf8')
  } catch {
    return Record({})
  }
  try {
    return Record(JSON.parse(raw) as RecordConfig)
  } catch {
    return Record({})
  }
}

/**
 * 合并式写入记录。
 *
 * 走"写临时文件再 `rename`"：设置页可能在引导中途来读，rename 是原子的，读到的
 * 要么是旧的一份完整记录，要么是新的一份，不会是半截 JSON。
 * @param patch - 要覆盖的字段。
 * @param current - 当前记录；省略时先读一次文件。
 * @returns 落定于写入完成，新记录。
 */
export async function writeRecord(patch: RecordConfig, current?: RecordConfig): Promise<RecordConfig> {
  const base = current ?? await readRecord()
  const next = Record({ ...base, ...patch })
  const path = recordFile()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staged = `${path}.staged`
  await writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await rename(staged, path)
  return next
}

/** 送到浏览器的记录视图。 */
export interface RecordView {
  /** 引导状态。 */
  state: string
  /** 隧道最近一次对外可见的状态。 */
  tunnelState: string
  /** 已生效的公网权威。 */
  publicAuthority: string
  /** 根证书指纹。 */
  caFingerprint: string
  /** 根证书 PEM 全文。 */
  caPem: string
  /** 中继主机公钥指纹。 */
  observedHostKeyFingerprint: string
  /** 最近一次失败。 */
  lastError: string
  /** 最近一次转发前预检。 */
  lastPreflight?: { outcome: string; message: string }
  /** 引导步骤。 */
  steps: readonly BootstrapStep[]
}

/**
 * 把记录投影成浏览器可见的那一份。
 *
 * 从**常量映射**而不是 `{ ...record }` 构造：白名单是编译期就定下的，新增记录字段
 * 不会自动跟着漏出去。`gateway.sessionSecret` 因此绝不可能骑上这一条响应——它是
 * 网关会话 Cookie 的比对值，泄露它等于让人伪造一个网关会话。
 * @param record - 完整记录。
 * @returns 只含白名单字段的视图。
 */
export function recordView(record: RecordConfig): RecordView {
  return {
    state: record.state ?? 'unconfigured',
    tunnelState: record.tunnelState ?? 'stopped',
    publicAuthority: record.publicAuthority ?? '',
    caFingerprint: record.caFingerprint ?? '',
    caPem: record.caPem ?? '',
    observedHostKeyFingerprint: record.observedHostKeyFingerprint ?? '',
    lastError: record.lastError ?? '',
    ...record.lastPreflight === undefined
      ? {}
      : { lastPreflight: { outcome: record.lastPreflight.outcome, message: record.lastPreflight.message ?? '' } },
    steps: record.steps ?? [],
  }
}
