/**
 * 部署参数从设置命名空间到一份不可变 `Deployment` 的规范化。
 *
 * 规范化是整个插件的分叉点：`apply` 只读它，引导、隧道、预检、权威注册都拿它当
 * 输入。它只描述"当前配置长什么样"，不回答"要不要动手"——那个决定属于用户点下
 * 部署的那一次写入，见 `service.ts` 的部署入口。
 * @module dsh-web-relay/deployment
 */

import { canonicalHostname, publicAuthority } from './authority.js'
import type { DeploymentConfig } from './config.js'

/** 规范化后的部署参数。除 `authority` 外都必然有值，因此下游不需要再判空。 */
export interface Deployment {
  /** 中继主机地址。 */
  readonly host: string
  /** 管理连接的 SSH 端口。 */
  readonly sshPort: number
  /** 管理账号。 */
  readonly user: string
  /** 管理账号私钥路径；留空表示走系统身份解析。 */
  readonly identityFile: string | undefined
  /** 期望的中继主机公钥指纹；留空表示首次连接按 TOFU 接受。 */
  readonly hostKeyFingerprint: string | undefined
  /** 公网入口 HTTPS 端口。 */
  readonly gatewayPort: number
  /** 网关口令；为空表示尚未配置。 */
  readonly password: string
  /** 部署完成后是否维持隧道。 */
  readonly autoStart: boolean
  /** 由 `host` 与 `gatewayPort` 推出的公网权威；`host` 为空或形状非法时为 undefined。 */
  readonly authority: string | undefined
  /** 权威里不带端口的主机名；Caddy 的 `default_sni` 需要它。 */
  readonly hostname: string | undefined
}

/** 把设置里的原始值规范化成一份快照。 */
export function normalize(raw: DeploymentConfig): Deployment {
  const host = (raw.vps?.host ?? '').trim()
  const gatewayPort = raw.gateway?.port ?? 8443
  return {
    host,
    sshPort: raw.vps?.port ?? 22,
    user: (raw.vps?.user ?? 'root').trim() || 'root',
    identityFile: nonEmpty(raw.vps?.identityFile),
    hostKeyFingerprint: nonEmpty(raw.vps?.hostKeyFingerprint),
    gatewayPort,
    password: raw.gateway?.password ?? '',
    autoStart: raw.tunnel?.autoStart ?? true,
    authority: host === '' ? undefined : publicAuthority(host, gatewayPort),
    hostname: host === '' ? undefined : canonicalHostname(host),
  }
}

/**
 * 空串与未设置在这里是同一种东西。
 *
 * 设置里清空一个字段写入的是空串，而 schema 默认值不会出现。下游只想问「有没有」，
 * 所以在这一步就把两者合并成 `undefined`。
 * @param value - 原始字符串。
 * @returns 去空白后的值，空则为 undefined。
 */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 部署参数是否齐全。
 *
 * 只有两个字段是硬要求：没有地址就无处可去，没有口令就配不出网关。其余字段都有
 * 可用的默认值。
 * @param deployment - 规范化结果。
 * @returns 可以引导与拉起隧道时为 true。
 */
export function isRunnable(deployment: Deployment): boolean {
  return deployment.host !== '' && deployment.password !== ''
}
