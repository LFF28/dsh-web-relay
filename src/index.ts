/**
 * dsh-web-relay 的宿主半边。
 *
 * 把内网主机上的 `dsh web` 经一台公网中继交给远程设备：SSH 反向隧道、只允许
 * loopback 转发的受限账号、网关口令、以及把公网权威注册进 DSH 自己的 Host/Origin
 * 围栏。六件事分在六个模块里——引导、隧道、转发前预检、入口、权威自检、服务面——
 * 这个文件只做接线。
 *
 * 服务面必须同步 provide：`cordis.patch.yml` 覆盖了 `connection` 行，那一行的
 * `trustedHosts` 是一个在注入满足之后才求值的 `!!js` 表达式，它要读
 * `ctx.webRelay.trustedHosts`。先 provide、再让 Loader 去通知它重解析配置，顺序
 * 反过来的话围栏会拿到一份不含公网权威的列表。
 * @module dsh-web-relay
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config as RelayConfigSchema, resolveRelayConfig, type RelayConfig } from './config.js'
import { registerRelaySettings } from './settings.js'
import { mountEntryRoute, RelayRuntime, WEB_RELAY_SERVICE } from './service.js'

/** 稳定的 Cordis 插件名。 */
export const name = 'web-relay'

/**
 * 依赖的服务。
 *
 * 刻意**不**包含 `connection`：插件的服务面是 `connection` 自己算受信列表时要读的
 * 东西，挂在模块级注入上会形成互相等待。入口那边用 `ctx.inject(['connection'], …)`
 * 开一个子 fiber 等它，子 fiber 的等待不影响插件自身的激活。
 */
export const inject = ['settings', 'subprocess', 'webServer']

/** 包内行为旋钮的 schema；部署参数走 `web-relay` 设置命名空间。 */
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
  const runtime = new RelayRuntime(deps, registerRelaySettings(ctx))

  // 先 provide：`connection` 行的表达式可能在下一瞬间就求值。
  ctx.provide(WEB_RELAY_SERVICE, runtime.handle)

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
