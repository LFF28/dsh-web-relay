/**
 * dsh-web-relay 的宿主半边。
 *
 * 把内网主机上的 `dsh web` 经一台公网中继交给远程设备：SSH 反向隧道、只允许
 * loopback 转发的受限账号、网关口令、以及把公网权威注册进 DSH 自己的 Host/Origin
 * 围栏。那些事分在各自的模块里——引导、隧道、转发前预检、入口、权威自检、记录——
 * 这个文件只做接线。
 *
 * 服务面必须同步 provide：`cordis.patch.yml` 覆盖了 `connection` 行，那一行的
 * `trustedHosts` 是一个在注入满足之后才求值的 `!!js` 表达式，它要读
 * `ctx.webRelay.trustedHosts`。先 provide、再让 Loader 去通知它重解析配置，顺序
 * 反过来的话围栏会拿到一份不含公网权威的列表。
 * @module dsh-web-relay
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// 仅类型：拉入 `ctx.connection`（记录接口挂在它的认证围栏之后）。
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import { Config as RelayConfigSchema, resolveRelayConfig, validateDeployment, type DeploymentConfig, type RelayConfig } from './config.js'
import { RECORD_PATH } from './namespaces.js'
import { RelaySettings } from './settings.js'
import { mountEntryRoute, RelayRuntime, WEB_RELAY_SERVICE } from './service.js'

/** 稳定的 Cordis 插件名。 */
export const name = 'web-relay'

/**
 * 依赖的服务。
 *
 * 刻意**不**包含 `connection`：插件的服务面是 `connection` 自己算受信列表时要读的
 * 东西，挂在模块级注入上会形成互相等待。记录接口那边用 `ctx.inject(['connection'], …)`
 * 开一个子 fiber 等它，子 fiber 的等待不影响插件自身的激活。
 */
export const inject = ['settings', 'subprocess', 'webServer']

/** 插件配置的 schema。 */
export const Config = RelayConfigSchema

/**
 * 装载插件。
 * @param ctx - 宿主插件上下文。
 * @param config - Loader 解析后的插件配置。
 * @returns 落定于目录准备与首次对账的开头；完整的引导与隧道在后台继续。
 */
export async function apply(ctx: Context, config?: RelayConfig): Promise<void> {
  const resolved = resolveRelayConfig(config)
  const deps = {
    ctx,
    logger: ctx.logger,
    webServer: ctx.webServer,
    subprocess: ctx.subprocess,
    config: resolved,
  }
  // 部署参数是 volatile 的：Loader 解析后给出的是一个活引用，插件读它、设置页写它，
  // 两边不需要经过第二份副本。手工搭的上下文可能没给这一节，兜一个空引用。
  const runtime = new RelayRuntime(deps, new RelaySettings(config?.deployment ?? emptyDeployment()))

  // 先 provide：`connection` 行的表达式可能在下一瞬间就求值。
  ctx.provide(WEB_RELAY_SERVICE, runtime.handle)

  // 交叉字段校验。挂在 `internal/config` 瀑布上，因为它同时覆盖两条写入路径：
  // volatile 提交（`_commitVolatile` 在提交值之前跑这个瀑布）与 `configEditor.edit`
  // （设置页写文档时跑）。校验失败时前者保留旧引用并记一行 warn，后者把异常抛回
  // 客户端，所以不会落下"存了但用不了"的值。
  //
  // `this !== ctx.fiber` 的过滤是必要的：这个瀑布对整棵树上的每一行都触发，不过滤的
  // 话别的插件解析配置时也会拿它的值来跑一遍我们的校验。
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw = next()
    if (this !== ctx.fiber) return raw
    const deployment = (raw as RelayConfig | undefined)?.deployment
    // 这一步的 `deployment` 可能是 volatile 引用（Loader 解析后），也可能已经是普通
    // 值（瀑布上游刚给出的候选）——两种都取内容来校验。
    if (isVolatileRef(deployment)) validateDeployment(deployment.get())
    else if (deployment !== undefined) validateDeployment(deployment)
    return raw
  })

  // 自带设置页的插件必须声明这一点：`autoGenerate` 默认是 true，那是给"按 schema
  // 自动生成配置页"的客户端用的。本插件自己的标签页才是它的设置面。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'dsh-web-relay: 设置页归属')
  })

  // 一次 volatile 提交就是一次部署请求。事件只派发给属主 fiber，所以这里不需要再筛
  // 一次来源；`deploy()` 内部排队，连着点也不会让两次引导互相拆台。
  ctx.on('loader/volatile-update', () => { void runtime.deploy() })

  // 运行记录的只读接口。挂在 DSH 共享 API 通道下，因此在 `connection` 的信任与认证
  // 围栏之后：未认证 401、权威不受信 403，插件不需要自开一条绕过认证的路径。
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: RECORD_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(Response.json(runtime.handle.record(), {
        headers: { 'cache-control': 'no-store' },
      })),
    }), 'dsh-web-relay: 运行记录接口')
  })

  // 入口始终注册：中继侧的改写与跳转都指向这条路径，只在 `entry.enabled` 为假时
  // 让它回一段说明，而不是让那条路径消失。
  ctx.effect(
    () => mountEntryRoute(deps, {
      authority: () => runtime.handle.authority(),
      enabled: () => resolved.entryEnabled,
    }),
    'dsh-web-relay: 公网入口路由',
  )
  ctx.effect(() => () => { void runtime.dispose() }, 'dsh-web-relay: 隧道生命周期')

  await runtime.start()
}

/**
 * 一份空的部署参数引用，只在手工搭的上下文里用。
 *
 * 正常路径下 Loader 已经解析出引用，这个函数不会被调用；它存在的意义只是让
 * `apply` 不必为"配置里没这一节"多一层判空分支。
 * @returns 永远返回空配置节的引用。
 */
function emptyDeployment(): Volatile<DeploymentConfig> {
  const value: DeploymentConfig = {}
  return { get: () => value }
}

/**
 * 判断 `internal/config` 拿到的是不是 volatile 引用。
 *
 * 不能只看 `typeof value.get === 'function'` 就下结论：`DeploymentConfig` 里没有
 * `get` 键，所以这里用一个显式谓词把两种形态分开，同时让类型收窄成立。
 * @param value - 候选值。
 * @returns 是 volatile 引用时为 true。
 */
function isVolatileRef(value: unknown): value is Volatile<DeploymentConfig> {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'get') === 'function'
}
