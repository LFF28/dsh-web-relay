/**
 * 两个设置命名空间的名字。
 *
 * 单独一个叶子模块，宿主与浏览器两半共用：浏览器半边要写这两个名字，但它绝不能
 * 值导入宿主半边——那会把 schemastery 和宿主插件图一起打进客户端 bundle。
 * @module dsh-web-relay/namespaces
 */

/** 用户填写的部署参数。 */
export const DEPLOYMENT_NS = 'web-relay'

/** 宿主写下的运行记录。 */
export const RECORD_NS = 'web-relay-record'
