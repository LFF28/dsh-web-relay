/**
 * 插件配置里那一份部署参数的门面。
 *
 * 0.2 起不再有 `ctx.settings.register`：设置表单直接长在插件自己的 `Config` 上，
 * 命名空间就是 Loader 条目 id。`deployment` 整棵子树是 volatile 的，因此
 * {@link RelaySettings} 拿到的是一份稳定引用，`get()` 是唯一读法。
 *
 * 这里只剩"读"，是因为"写"有了更好的归属：用户点部署时，设置页通过
 * `ctx.configForms` 直接改写这份配置文档，插件不需要自己实现写入路径。插件因此
 * 只监听 `loader/volatile-update`——一次提交就是一次部署请求。
 * @module dsh-web-relay/settings
 */

import type { Volatile } from '@deepseek-ai/cordis'
import type { DeploymentConfig } from './config.js'
import { normalize, type Deployment } from './deployment.js'
import { DEPLOYMENT_NS } from './namespaces.js'

export { DEPLOYMENT_NS }

/** 部署参数的活引用。 */
export class RelaySettings {
  /**
   * @param deploymentRef - `Config.deployment` 的 volatile 引用。
   */
  constructor(private readonly deploymentRef: Volatile<DeploymentConfig>) {}

  /**
   * 当前部署参数，已规范化。
   *
   * `Volatile.get()` 返回一份冻结的快照，所以规范化结果可以放心交给下游当输入用。
   * @returns 不可变快照。
   */
  deployment(): Deployment {
    return normalize(this.deploymentRef.get())
  }

  /**
   * 当前部署参数的原样值。
   * @returns 未规范化的配置节。
   */
  raw(): DeploymentConfig {
    return this.deploymentRef.get()
  }
}
