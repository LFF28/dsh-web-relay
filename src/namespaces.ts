/**
 * 宿主与浏览器两半共用的两个标识。
 *
 * 单独一个叶子模块，因为它会被打进客户端 bundle：这里只能放纯常量，绝不能出现
 * 任何 `node:` 导入——浏览器半边值导入宿主模块会把宿主插件图一起拖进产物。
 * @module dsh-web-relay/namespaces
 */

/**
 * 部署参数所在的插件条目 id。
 *
 * 0.2 起设置表单直接落在插件自己的 `Config` 上，命名空间就是 Loader 条目的 id，
 * 而条目 id 由本插件 `cordis.patch.yml` 里那一行决定。
 */
export const DEPLOYMENT_NS = 'web-relay'

/**
 * 运行记录接口路径。
 *
 * 挂在 DSH 共享 API 通道下，因此天然落在 `connection` 的信任与认证围栏之后：
 * 未认证回 401、权威不受信回 403，插件不需要自开一条绕过认证的接口。
 */
export const RECORD_PATH = '/api/web-relay.record'
