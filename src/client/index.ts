/**
 * dsh-web-relay 的浏览器半边。
 *
 * 一个贡献：设置菜单里的一个标签页。它只在宿主确实在服务这两个命名空间时注册
 * ——没装这个插件的部署不应该在设置菜单里留下它的痕迹，非 loopback 页面也读不到
 * 这两个命名空间，因此手机上不会出现这个标签。
 *
 * 运行时只 import 平台模块表里的包（`react`、`@deepseek-ai/dsh-client-ui-slots`、
 * `@deepseek-ai/dsh-client-ui-primitives`），其余全是 `import type`：客户端 bundle
 * 的纯净性由平台模块表把关，值导入一个非平台包会在页面加载时直接炸掉。
 * @module dsh-web-relay/client
 */

import { useSyncExternalStore } from 'react'
// 仅类型：拉入 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 仅类型：拉入 SettingsScope 的 Context 合并（ctx.settingsScope）与 settings.section 的槽位声明。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 仅类型：拉入插槽注册表的 Context 合并（ctx.slots）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEPLOYMENT_NS, RECORD_NS } from '../namespaces.js'
import { RelaySection } from './section.js'
import type { RelayDeploymentView, RelayDraft, RelayFace, RelayRecordView, RelayView } from './face.js'
import { en, zh } from './locales.js'

/** 文案命名空间。 */
export const NS = 'web-relay'

/** 依赖的服务。 */
export const inject = ['slots', 'locale', 'settingsScope']

/** 标签页在设置导航栏里的位置；排在内建的归档会话页之后。 */
const SECTION_ORDER = 30

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
  }, 'dsh-web-relay: 设置页')
}

/**
 * 注册标签页。
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
  return ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'web-relay',
    order: SECTION_ORDER,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: () => createFace(deploymentScope, recordScope),
  }, RelaySection))
}

/**
 * 组装页面业务面。
 *
 * `useRelay` 用 `useSyncExternalStore` 读两份作用域快照：两个命名空间各自变化
 * 都会让页面重渲染，因为一次部署会同时写两边。
 * @param deploymentScope - `web-relay` 命名空间的作用域。
 * @param recordScope - `web-relay-record` 命名空间的作用域。
 * @returns 业务面。
 */
function createFace(
  deploymentScope: SettingsScope<RelayDeploymentView>,
  recordScope: SettingsScope<RelayRecordView>,
): RelayFace {
  // `useSyncExternalStore` 要求 `getSnapshot` 在两次读之间返回同一个引用，而
  // `project` 每次都造新对象。这里保留上一份投影，只有作用域真的变了才重算。
  let snapshot: RelayView | undefined
  const read = (): RelayView => {
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
    useRelay: <T>(select: (view: RelayView) => T): T => select(useSyncExternalStore(subscribe, read)),
    deploy: async (draft: RelayDraft): Promise<boolean> => {
      const current = deploymentScope.getSnapshot().value
      const request = typeof current?.deploy?.request === 'number' ? current.deploy.request : 0
      await deploymentScope.mutate(operations(draft, request + 1))
      return deploymentScope.getSnapshot().value?.deploy?.request === request + 1
    },
  }
}

/**
 * 把表单草稿变成一组路径操作。
 *
 * 逐字段写而不是整体覆盖：整体覆盖会连 `gateway.password` 一起抹掉——那个字段
 * 从来就没到过浏览器。一组操作共享同一次修订栅栏、同一次校验与同一次落盘，所以
 * `vps.host` 的跨字段约束与"口令非空"的约束都成立，也不会落下中途被拒的中间态。
 *
 * `deploy` 一段与表单值在这一次写入里一起提交：设置服务对解析后的值做深层相等
 * 短路，只改计数也足以让这次提交成为一次真实变更，于是"什么都没改也要重来一遍"
 * 与"改了字段"走的是同一条路。
 * @param draft - 表单里的值。
 * @param request - 本次部署的请求计数。
 * @returns 操作列表。
 */
function operations(draft: RelayDraft, request: number): SettingsPathOperation[] {
  return [
    { op: 'set', path: ['vps', 'host'], value: draft.host.trim() },
    { op: 'set', path: ['vps', 'port'], value: port(draft.sshPort, 22) },
    { op: 'set', path: ['vps', 'user'], value: draft.user.trim() === '' ? 'root' : draft.user.trim() },
    { op: 'set', path: ['vps', 'identityFile'], value: draft.identityFile.trim() },
    { op: 'set', path: ['vps', 'hostKeyFingerprint'], value: draft.hostKeyFingerprint.trim() },
    { op: 'set', path: ['gateway', 'port'], value: port(draft.gatewayPort, 8443) },
    { op: 'set', path: ['gateway', 'password'], value: draft.password },
    { op: 'set', path: ['deploy', 'request'], value: request },
    { op: 'set', path: ['deploy', 'autoDeploy'], value: draft.autoDeploy },
  ]
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
 * 把两份作用域快照投影成页面快照。
 * @param deployment - `web-relay` 的快照。
 * @param record - `web-relay-record` 的快照。
 * @returns 页面快照。
 */
function project(
  deployment: SettingsScopeSnapshot<RelayDeploymentView>,
  record: SettingsScopeSnapshot<RelayRecordView>,
): RelayView {
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
