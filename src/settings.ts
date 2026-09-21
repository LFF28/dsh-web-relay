/**
 * 插件拥有的两个设置命名空间。
 *
 * 分开的理由是它们在语义上是两份文档：`web-relay` 是用户写的部署参数（插件只读，
 * 校验形状），`web-relay-record` 是插件写的运行记录（用户只读，卡片拿它显示状态）。
 * 混在一个命名空间里会让"用户清空一个字段"与"插件更新一次记录"互相覆盖。
 * @module dsh-web-relay/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  Deployment as DeploymentSchema,
  Record as RecordSchema,
  validateDeployment,
  type DeploymentConfig,
  type RecordConfig,
} from './config.js'
import { normalize, type Deployment } from './deployment.js'
import { DEPLOYMENT_NS, RECORD_NS } from './namespaces.js'

export { DEPLOYMENT_NS, RECORD_NS }

/**
 * 注册两个命名空间并交出读写两个作用域。
 *
 * 两个 `register` 都是作用在插件 fiber 上的 effect：插件卸载时命名空间随之消失。
 */
export class RelaySettings {
  /**
   * @param deploymentScope - `web-relay` 的属主作用域。
   * @param recordScope - `web-relay-record` 的属主作用域。
   */
  constructor(
    private readonly deploymentScope: SettingsScope<DeploymentConfig>,
    private readonly recordScope: SettingsScope<RecordConfig>,
  ) {}

  /**
   * 当前部署参数，已规范化。
   * @returns 不可变快照。
   */
  deployment(): Deployment {
    return normalize(this.deploymentScope.get())
  }

  /**
   * 订阅部署参数变化。
   *
   * 回调不带参数：宿主不关心变了什么，一次提交就是一次部署请求。
   * @param listener - 每次提交后调用。
   * @returns 取消订阅的函数。
   */
  watch(listener: () => void | Promise<void>): () => void {
    return this.deploymentScope.watch(() => listener())
  }

  /**
   * 当前运行记录。
   * @returns 记录整节（缺省字段已由 schema 填好）。
   */
  record(): RecordConfig {
    return this.recordScope.get()
  }

  /**
   * 合并式写入运行记录。
   * @param patch - 要覆盖的字段。
   * @returns 落定于写入完成。
   */
  async patchRecord(patch: object): Promise<void> {
    await this.recordScope.update(patch)
  }
}

/**
 * 注册两个命名空间。
 *
 * `web-relay` 带交叉字段校验：形状非法的 `vps.host` 在写入时就被拒，而不是存下来
 * 之后让围栏在运行期拒绝——后者的表现是"手机打开是 403"，而用户手上没有任何线索
 * 指向那个多余的路径或空白。
 * @param ctx - 插件上下文，`settings` 必须在注入表里。
 * @returns 两个作用域的读写门面。
 */
export function registerRelaySettings(ctx: Context): RelaySettings {
  const deploymentScope = ctx.settings.register(DEPLOYMENT_NS, DeploymentSchema, {
    validate: (value: unknown) => { validateDeployment(value as DeploymentConfig) },
  })
  const recordScope = ctx.settings.register(RECORD_NS, RecordSchema)
  return new RelaySettings(deploymentScope, recordScope)
}
