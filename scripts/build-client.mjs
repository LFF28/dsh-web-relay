/**
 * 把浏览器半边打成一个闭包工厂产物。
 *
 * 仓库内的 `packages/client/tsdown.client.ts` 预设树外不可用：它按相对路径
 * import、并且 glob `packages/*​/* /package.json` 找包名，出了这个工作区就抛错。
 * 这里用 esbuild 复刻它产物的三件套，只依赖一个构建器。
 *
 * 产物形状（加载器只认这一种）：
 *
 *   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     …打包后的代码…
 *     return module.exports; } });
 *
 * `id` 必须是包名：宿主按“最近的 package.json 的 name”作为行 id，对不上就静默
 * 不加载。外部依赖只允许平台模块表那九项，其余一律内联——表外的运行期请求会
 * 在浏览器里抛 “missed the module table”。
 */
import { build } from 'esbuild'

/** 平台共享的模块表（`packages/client/web/src/platform.ts` 的 PLATFORM_MODULES）。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const PACKAGE_NAME = 'dsh-web-relay'

// esbuild 没有 rollup 的 `intro` 选项：开头的两行声明并进 banner，紧跟工厂函数体
// 的左花括号，效果与预设产物一致。
const HEADER = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  banner: { js: HEADER },
  footer: { js: 'return module.exports; } });' },
  legalComments: 'none',
})
