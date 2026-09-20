/**
 * dsh-web-relay 的浏览器半边。
 *
 * 一个贡献：Plugins 页里的一张配置卡。它只在宿主确实在服务这两个命名空间时注册
 * ——没装这个插件的部署不应该在页面上留下它的痕迹。
 *
 * 运行时只 import 平台模块表里的包（`react`、`@deepseek-ai/dsh-client-ui-slots`、
 * `@deepseek-ai/dsh-client-ui-primitives`），其余全是 `import type`：客户端 bundle
 * 的纯净性由平台模块表把关，值导入一个非平台包会在页面加载时直接炸掉。
 * @module dsh-web-relay/client
 */

import { useSyncExternalStore } from 'react'
// 仅类型：拉入 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 仅类型：拉入 Plugins 页的 SlotMap 合并（`plugins.item`）。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// 仅类型：拉入 SettingsScope 的 Context 合并（ctx.settingsScope）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 仅类型：拉入插槽注册表的 Context 合并（ctx.slots）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEPLOYMENT_NS, RECORD_NS } from '../namespaces.js'
import { RelayCard } from './card.js'
import type { RelayCardFace, RelayCardState, RelayDeploymentView, RelayDraft, RelayRecordView } from './face.js'
import { en, zh } from './locales.js'

/** 文案命名空间。 */
export const NS = 'web-relay'

/** 依赖的服务。 */
export const inject = ['slots', 'locale', 'settingsScope']

/** 卡片在 Plugins 页 Official 组里的位置；官方卡片用到 40，这里排在后面。 */
const CARD_ORDER = 60

/**
 * 装载客户端半边。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-relay: 文案')

  const deploymentScope: SettingsScope<RelayDeploymentView> = ctx.settingsScope.bind({ namespace: DEPLOYMENT_NS })
  const recordScope: SettingsScope<RelayRecordView> = ctx.settingsScope.bind({ namespace: RECORD_NS })
  const describeFace = ctx.settingsScope.describe()
  ctx.effect(() => {
    let off: (() => void) | undefined
    const sync = (): void => {
      const served = new Set(describeFace.getSnapshot().view?.namespaces.map(view => view.ns) ?? [])
      const available = served.has(DEPLOYMENT_NS) && served.has(RECORD_NS)
      if (available && off === undefined) off = register(ctx, deploymentScope, recordScope)
      else if (!available && off !== undefined) { off(); off = undefined }
    }
    const unsubscribe = describeFace.subscribe(sync)
    void describeFace.ensure()
    sync()
    return () => { unsubscribe(); off?.() }
  }, 'dsh-web-relay: 配置卡片')
}

/**
 * 注册卡片。
 * @param ctx - 浏览器插件上下文。
 * @param deploymentScope - `web-relay` 命名空间的作用域。
 * @param recordScope - `web-relay-record` 命名空间的作用域。
 * @returns 释放器。
 */
function register(
  ctx: Context,
  deploymentScope: SettingsScope<RelayDeploymentView>,
  recordScope: SettingsScope<RelayRecordView>,
): () => void {
  return ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'web-relay',
    order: CARD_ORDER,
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
    inject: () => createFace(deploymentScope, recordScope),
  }, RelayCard))
}

/**
 * 组装卡片业务面。
 *
 * `useRelayCard` 用 `useSyncExternalStore` 读两份作用域快照：两个命名空间各自变化
 * 都会让卡片重渲染，因为一次引导会同时写两边。
 * @param deploymentScope - `web-relay` 命名空间的作用域。
 * @param recordScope - `web-relay-record` 命名空间的作用域。
 * @returns 业务面。
 */
function createFace(
  deploymentScope: SettingsScope<RelayDeploymentView>,
  recordScope: SettingsScope<RelayRecordView>,
): RelayCardFace {
  // `useSyncExternalStore` 要求 `getSnapshot` 在两次读之间返回同一个引用，而
  // `project` 每次都造新对象。这里保留上一份投影，只有作用域真的变了才重算。
  let snapshot: RelayCardState | undefined
  const read = (): RelayCardState => {
    snapshot ??= project(deploymentScope.getSnapshot(), recordScope.getSnapshot())
    return snapshot
  }
  const subscribe = (listener: () => void): (() => void) => {
    const changed = (): void => { snapshot = undefined; listener() }
    const offDeployment = deploymentScope.subscribe(changed)
    const offRecord = recordScope.subscribe(changed)
    return () => { offDeployment(); offRecord() }
  }
  return {
    useRelayCard: <T>(select: (state: RelayCardState) => T): T => select(useSyncExternalStore(subscribe, read)),
    save: async (draft: RelayDraft): Promise<void> => {
      await deploymentScope.mutate(operations(draft))
    },
    requestBootstrap: async (): Promise<void> => {
      const current = deploymentScope.getSnapshot().value
      const request = typeof current?.bootstrapRequest === 'number' ? current.bootstrapRequest : 0
      await deploymentScope.mutate([{ op: 'set', path: ['bootstrapRequest'], value: request + 1 }])
    },
  }
}

/**
 * 把表单草稿变成一组路径操作。
 *
 * 逐字段写而不是整体覆盖：整体覆盖会连 `gateway.password` 一起抹掉——那个字段
 * 从来就没到过浏览器。一组操作共享同一次修订栅栏、同一次校验与同一次落盘，所以
 * `vps.host` 的跨字段约束仍然成立，也不会落下中途被拒的中间态。
 * @param draft - 表单里的值。
 * @returns 操作列表。
 */
function operations(draft: RelayDraft): SettingsPathOperation[] {
  const ops: SettingsPathOperation[] = [
    { op: 'set', path: ['vps', 'host'], value: draft.host.trim() },
    { op: 'set', path: ['vps', 'port'], value: port(draft.sshPort, 22) },
    { op: 'set', path: ['vps', 'user'], value: draft.user.trim() === '' ? 'root' : draft.user.trim() },
    { op: 'set', path: ['vps', 'identityFile'], value: draft.identityFile.trim() },
    { op: 'set', path: ['vps', 'hostKeyFingerprint'], value: draft.hostKeyFingerprint.trim() },
    { op: 'set', path: ['gateway', 'port'], value: port(draft.gatewayPort, 8443) },
    { op: 'set', path: ['tunnel', 'autoStart'], value: draft.autoStart },
  ]
  // 留空表示"不修改"：口令字段永远不会带着旧值回到浏览器，能被写成空串的只有
  // 用户刚刚输入的内容。
  if (draft.password !== '') ops.push({ op: 'set', path: ['gateway', 'password'], value: draft.password })
  return ops
}

/** 一次路径写入。与线协议上的 `SettingsPathOpView` 同构，在这里就地声明以免
 * 客户端值导入 `@deepseek-ai/dsh-api-remotes`。 */
type SettingsPathOperation =
  | { readonly op: 'set'; readonly path: string[]; readonly value: string | number | boolean }
  | { readonly op: 'unset'; readonly path: string[] }

/**
 * 把输入框里的数字压成合法端口。
 * @param text - 输入框原文。
 * @param fallback - 解析不出来时用的值。
 * @returns 1 到 65535 之间的整数。
 */
function port(text: string, fallback: number): number {
  const value = Number.parseInt(text, 10)
  return Number.isSafeInteger(value) && value > 0 && value <= 65535 ? value : fallback
}

/**
 * 把两份作用域快照投影成卡片快照。
 * @param deployment - `web-relay` 的快照。
 * @param record - `web-relay-record` 的快照。
 * @returns 卡片快照。
 */
function project(
  deployment: SettingsScopeSnapshot<RelayDeploymentView>,
  record: SettingsScopeSnapshot<RelayRecordView>,
): RelayCardState {
  const value = deployment.value
  const written = record.value
  const state = written?.state
  const tunnel = written?.tunnelState
  return {
    status: deployment.status === 'ready' && record.status === 'ready' ? 'ready' : deployment.status,
    writable: deployment.writable,
    ...value === undefined ? {} : { deployment: value },
    ...written === undefined ? {} : { record: written },
    state: state === 'ready' || state === 'bootstrapping' || state === 'failed' ? state : 'unconfigured',
    tunnel: tunnel === 'starting' || tunnel === 'running' || tunnel === 'backing-off' ? tunnel : 'stopped',
    authority: written?.publicAuthority ?? '',
    steps: written?.steps ?? [],
  }
}
