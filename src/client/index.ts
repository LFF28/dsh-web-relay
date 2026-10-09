/**
 * dsh-web-relay 的浏览器半边。
 *
 * 一个贡献：设置菜单里的一个标签页。它只在宿主确实在服务这个插件条目时注册
 * ——没装这个插件的部署不应该在设置菜单里留下它的痕迹。非 loopback 页面读不到
 * 配置文档（`configForms` 在 memory 模式下是 `unavailable`），因此手机上不会出现
 * 这个标签页，行为与迁移前一致。
 *
 * 运行时只 import 平台模块表里的包（`react`、`@deepseek-ai/dsh-client-ui-slots`、
 * `@deepseek-ai/dsh-client-ui-primitives`），其余全是 `import type`：客户端 bundle
 * 的纯净性由平台模块表把关，值导入一个非平台包会在页面加载时直接炸掉。
 * @module dsh-web-relay/client
 */

import { useSyncExternalStore } from 'react'
// 仅类型：拉入 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 仅类型：拉入配置表单服务的 Context 合并（ctx.configForms）与 settings.section 的槽位声明。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 仅类型：拉入插槽注册表的 Context 合并（ctx.slots）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEPLOYMENT_NS, RECORD_PATH } from '../namespaces.js'
import { RelaySection } from './section.js'
import type { RelayConfigSection, RelayDraft, RelayFace, RelayRecordView, RelayView } from './face.js'
import { en, zh } from './locales.js'

/** 文案命名空间。 */
export const NS = 'web-relay'

/** 依赖的服务。 */
export const inject = ['slots', 'locale', 'configForms']

/** 标签页在设置导航栏里的位置；排在内建的归档会话页之后。 */
const SECTION_ORDER = 30

/** 记录轮询的间隔（毫秒）。只在一次部署看起来还在进行时才用得上。 */
const RECORD_POLL_MS = 1500

/**
 * 装载客户端半边。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-relay: 文案')

  const form = ctx.configForms.get<RelayConfigSection>(DEPLOYMENT_NS)
  ctx.effect(
    () => ctx.configForms.whileServed([DEPLOYMENT_NS], () => register(ctx, form)),
    'dsh-web-relay: 设置页',
  )
}

/**
 * 注册标签页。
 * @param ctx - 浏览器插件上下文。
 * @param form - 插件条目的配置表单。
 * @returns 释放器。
 */
function register(ctx: Context, form: ConfigForm<RelayConfigSection>): () => void {
  return ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'web-relay',
    order: SECTION_ORDER,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: () => createFace(form),
  }, RelaySection))
}

/**
 * 组装页面业务面。
 *
 * 两条订阅：表单快照（部署参数）与记录（按需轮询）。任何一边变化都让页面重渲染。
 * @param form - 插件条目的配置表单。
 * @returns 业务面。
 */
function createFace(form: ConfigForm<RelayConfigSection>): RelayFace {
  let snapshot: RelayView | undefined
  let record: RelayRecordView | undefined
  let loaded = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  const listeners = new Set<() => void>()
  const notify = (): void => { snapshot = undefined; for (const listener of listeners) listener() }

  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch(RECORD_PATH, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      record = response.ok ? await response.json() as RelayRecordView : undefined
    } catch {
      // 记录读不到不是错误：网络暂时不通时页面保持上一份，状态区不会因此变空。
    }
    loaded = true
    notify()
  }

  /**
   * 按当前记录决定要不要继续轮询。
   *
   * 只在"引导进行中"或"隧道正在连接/重连"时轮询：那两种状态下记录会自己变，页面
   * 得跟着动。落定之后（就绪、失败、未配置）就停下来——中继那条链路带宽有限，闲置
   * 时的定时请求是纯粹的开销。
   */
  const schedule = (): void => {
    if (timer !== undefined) return
    const busy = record?.state === 'bootstrapping'
      || record?.tunnelState === 'starting'
      || record?.tunnelState === 'backing-off'
    if (!busy) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh().then(schedule)
    }, RECORD_POLL_MS)
  }

  const read = (): RelayView => {
    snapshot ??= project(form.getSnapshot(), record, loaded)
    return snapshot
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    // 首轮取记录只做一次：`subscribe` 会被 React 反复调用（StrictMode 下更是如此），
    // 每次进来都发一个请求会让中继那条链路平白多出几倍流量。
    if (!started) {
      started = true
      void refresh().then(schedule)
    }
    const offForm = form.subscribe(notify)
    return () => {
      offForm()
      listeners.delete(listener)
      if (listeners.size === 0 && timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }

  return {
    useRelay: <T>(select: (view: RelayView) => T): T => select(useSyncExternalStore(subscribe, read)),
    deploy: async (draft: RelayDraft): Promise<boolean> => {
      const current = form.getSnapshot().value?.deployment
      const request = typeof current?.deploy?.request === 'number' ? current.deploy.request : 0
      const landed = await form.mutate(operations(draft, request + 1))
      // 写入成功后立刻取一次记录：宿主已经在跑了，页面不该等下一个轮询周期才动。
      if (landed) void refresh().then(schedule)
      return landed
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
 *
 * 路径的第一段是 `deployment`：volatile 子树在 `Config` 里的位置就在那里。
 * @param draft - 表单里的值。
 * @param request - 本次部署的请求计数。
 * @returns 操作列表。
 */
function operations(draft: RelayDraft, request: number): SettingsPathOperation[] {
  return [
    { op: 'set', path: ['deployment', 'vps', 'host'], value: draft.host.trim() },
    { op: 'set', path: ['deployment', 'vps', 'port'], value: port(draft.sshPort, 22) },
    { op: 'set', path: ['deployment', 'vps', 'user'], value: draft.user.trim() === '' ? 'root' : draft.user.trim() },
    { op: 'set', path: ['deployment', 'vps', 'identityFile'], value: draft.identityFile.trim() },
    { op: 'set', path: ['deployment', 'vps', 'hostKeyFingerprint'], value: draft.hostKeyFingerprint.trim() },
    { op: 'set', path: ['deployment', 'gateway', 'port'], value: port(draft.gatewayPort, 8443) },
    { op: 'set', path: ['deployment', 'gateway', 'password'], value: draft.password },
    { op: 'set', path: ['deployment', 'deploy', 'request'], value: request },
    { op: 'set', path: ['deployment', 'deploy', 'autoDeploy'], value: draft.autoDeploy },
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
 * 把表单快照与记录投影成页面快照。
 *
 * 表单 `unavailable` 时整页只读（与迁移前一致）；否则等记录第一次到位才显示就绪，
 * 免得上半屏已经有表单、下半屏还空着。
 * @param form - 配置表单快照。
 * @param record - 最近一次取到的记录。
 * @param loaded - 记录是不是已经取过一次。
 * @returns 页面快照。
 */
function project(
  form: ConfigFormSnapshot<RelayConfigSection>,
  record: RelayRecordView | undefined,
  loaded: boolean,
): RelayView {
  const value = form.value?.deployment
  const state = record?.state
  const tunnel = record?.tunnelState
  const status = form.status === 'unavailable' ? 'unavailable'
    : form.status === 'ready' && (record !== undefined || loaded) ? 'ready'
      : 'loading'
  return {
    status,
    writable: form.status === 'ready' && form.writable,
    ...value === undefined ? {} : { deployment: value },
    ...record === undefined ? {} : { record },
    state: state === 'ready' || state === 'bootstrapping' || state === 'failed' ? state : 'unconfigured',
    tunnel: tunnel === 'starting' || tunnel === 'running' || tunnel === 'backing-off' ? tunnel : 'stopped',
    authority: record?.publicAuthority ?? '',
    steps: record?.steps ?? [],
  }
}
