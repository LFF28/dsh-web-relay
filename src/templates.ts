/**
 * `deploy/` 模板的加载、占位符替换，以及「托管块」写入脚本的生成。
 *
 * 三处托管块（`authorized_keys`、`sshd` 片段、`Caddyfile`）用同一段脚本写入：滤掉旧块、
 * 追加新块、装到目标路径、再读回来比对。写成一段而不是三段，是因为「读回来比对」
 * 这一步一旦有一处漏掉，表现就是「引导说成功了但中继上没生效」——静默写入失败比
 * 写入失败更难查。
 * @module dsh-web-relay/templates
 */

import { readFile } from 'node:fs/promises'

/** 托管块的开始标记行。 */
const BEGIN = '# BEGIN dsh-web-relay'

/** 托管块的结束标记行。 */
const END = '# END dsh-web-relay'

/** 模板所在目录，相对于本模块。`src/` 与 `lib/` 都在包根下一层，所以是同一个值。 */
const DEPLOY_DIR = new URL('../deploy/', import.meta.url)

/**
 * 读取一个模板文件。
 * @param relativePath - 相对 `deploy/` 的路径，例如 `Caddyfile.snippet`。
 * @returns 模板原文。
 * @throws {Error} 文件缺失或不可读时。
 */
export async function readTemplate(relativePath: string): Promise<string> {
  return await readFile(new URL(relativePath, DEPLOY_DIR), 'utf8')
}

/**
 * 替换模板里的 `@@KEY@@` 占位符。
 *
 * 用函数式替换而不是字符串替换：bcrypt 哈希里全是 `$`，字符串替换会把 `$&`、`$1`
 * 之类的序列当成捕获组引用，替换出来的哈希就是错的，而 `caddy validate` 会通过、
 * 只有在浏览器上输口令才发现。
 * @param template - 模板原文。
 * @param values - 占位符键到值的映射。
 * @returns 替换后的文本。
 * @throws {Error} 有占位符没被替换时。
 */
export function substitute(template: string, values: Readonly<Record<string, string>>): string {
  let output = template
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`@@${key}@@`, () => value)
  }
  const leftover = /@@[A-Z0-9_]+@@/.exec(output)
  if (leftover !== null) {
    throw new Error(`模板占位符未被替换：${leftover[0]}`)
  }
  return output
}

/**
 * 从模板里取出托管块本体，即 `# BEGIN dsh-web-relay` 到 `# END dsh-web-relay` 的
 * 闭区间。
 *
 * 这一步不能省：模板开头有一段解释用法的注释，它落在标记之外。直接把整份模板当块
 * 内容写进去，第一次没问题，第二次过滤时只删掉标记之间的部分，那段注释会留下来并
 * 被再写一遍——每引导一次就多一份。取块本体让"块内容"与"会被过滤掉的范围"逐字
 * 相等。
 * @param text - 模板全文（占位符已替换）。
 * @returns 托管块本体，含两行标记。
 * @throws {Error} 标记不完整时。
 */
export function extractManagedBlock(text: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === BEGIN)
  const end = lines.findIndex((line, index) => index > start && line.trimEnd() === END)
  if (start === -1 || end === -1) {
    throw new Error(`模板里找不到完整的托管块标记（${BEGIN} … ${END}）`)
  }
  return lines.slice(start, end + 1).join('\n')
}

/** 一处托管块或整文件的目标。 */
export interface ManagedFile {
  /** 远端绝对路径。 */
  readonly path: string
  /** 安装后的权限位，八进制字面量，例如 `0o600`。 */
  readonly mode: number
  /** 属主；省略表示保持安装者（即 `sudo` 的 root）。 */
  readonly owner?: string
  /** 属组；省略表示与属主相同。 */
  readonly group?: string
  /**
   * 安装后必须通过的校验命令，单行、可用 `&&` 串联。
   *
   * 给的是「校验」而不是「生效」：校验失败时脚本先恢复安装前的内容再以退出码 5
   * 结束，因此同一段脚本里跟在后面的 `systemctl reload` 根本不会执行。`sshd` 与
   * Caddy 都靠这一条实现「先验证再重载，验证不过就回滚」。
   */
  readonly guard?: string
  /**
   * 块放在文件的哪里。默认 `bottom`。
   *
   * Caddy 的全局选项块必须是文件里的第一样东西，所以 Caddyfile 用 `top`；其余
   * 两处（`authorized_keys` 与 `sshd_config`）按惯例追加在末尾。
   */
  readonly position?: 'top' | 'bottom'
}

/**
 * 生成写入托管块的 POSIX `sh` 脚本。
 *
 * 脚本幂等：先按标记滤掉旧块，再追加新块，块外内容原样保留。写入走「临时文件 +
 * `install`」的原子替换，因此中途失败留下的要么是旧块要么是新块，不会是半个。
 * 最后把块读回来与写入内容逐字节比对，不一致就以退出码 3 失败。
 *
 * 声明了 {@link ManagedFile.guard} 时还会先备份目标，校验不通过就恢复备份（此前
 * 没有这个文件则删掉它）并以退出码 5 失败。
 * @param file - 目标路径与权限。
 * @param blockContent - 模板全文或块本体；块本体由 {@link extractManagedBlock} 取出。
 * @returns 交给 `sh` 从 stdin 执行的脚本全文。
 */
export function managedBlockScript(file: ManagedFile, blockContent: string): string {
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  const group = file.group ?? file.owner
  const ownership = file.owner === undefined
    ? ''
    : ` -o ${quoted(file.owner)}${group === undefined ? '' : ` -g ${quoted(group)}`}`
  const mode = file.mode.toString(8).padStart(4, '0')
  const block = extractManagedBlock(blockContent)
  const filtered = `awk '/^${BEGIN}$/ { inside = 1 } inside == 0 { print } /^${END}$/ { inside = 0 }'`
  const extracted = `awk '/^${BEGIN}$/ { inside = 1 } inside == 1 { print } /^${END}$/ { inside = 0 }'`
  const assemble = file.position === 'top'
    ? 'cat "$work/block" "$work/outside" > "$work/next"'
    : 'cat "$work/outside" "$work/block" > "$work/next"'
  const lines = [
    'set -eu',
    `target=${quoted(file.path)}`,
    'work=$(mktemp -d)',
    `trap 'rm -rf "$work"' EXIT`,
    // heredoc 自带每行一个换行，块本身就满足"以换行结尾"，不需要再补。
    `cat > "$work/block" <<'DSH_WEB_RELAY_BLOCK'`,
    block.replace(/\n+$/, ''),
    'DSH_WEB_RELAY_BLOCK',
    'existed=0',
    'if [ -f "$target" ]; then',
    '  existed=1',
    '  cp -p "$target" "$work/backup"',
    `  ${filtered} "$target" > "$work/outside"`,
    'else',
    '  : > "$work/outside"',
    'fi',
    'if [ -s "$work/outside" ] && [ "$(tail -c 1 "$work/outside" | wc -l)" -eq 0 ]; then printf \'\\n\' >> "$work/outside"; fi',
    assemble,
    'if [ -s "$work/next" ] && [ "$(tail -c 1 "$work/next" | wc -l)" -eq 0 ]; then printf \'\\n\' >> "$work/next"; fi',
    `install -m ${mode}${ownership} "$work/next" "$target"`,
    `${extracted} "$target" > "$work/readback"`,
    'if ! cmp -s "$work/block" "$work/readback"; then echo "托管块回读不一致：$target" >&2; exit 3; fi',
  ]
  if (file.guard !== undefined) {
    lines.push(
      `if ! ${file.guard}; then`,
      '  if [ "$existed" = 1 ]; then cp -p "$work/backup" "$target"; else rm -f "$target"; fi',
      `  echo "校验未通过，已恢复安装前的内容：$target" >&2`,
      '  exit 5',
      'fi',
    )
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 生成写入**整文件**的脚本。
 *
 * 用于 fail2ban 的两份配置：目标路径上已有同名文件而首行不是本项目标记时停下，
 * 不覆盖用户自己写的东西。
 * @param file - 目标路径与权限。
 * @param content - 文件全文。
 * @returns 脚本全文。
 */
export function wholeFileScript(file: ManagedFile, content: string): string {
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  return [
    'set -eu',
    `target=${quoted(file.path)}`,
    'if [ -f "$target" ] && ! head -n 1 "$target" | grep -q dsh-web-relay; then',
    '  echo "已存在的文件不是本插件写的，停下：$target" >&2; exit 4',
    'fi',
    'tmp=$(mktemp)',
    'trap \'rm -f "$tmp"\' EXIT',
    `cat > "$tmp" <<'DSH_WEB_RELAY_FILE'`,
    content.replace(/\n+$/, ''),
    'DSH_WEB_RELAY_FILE',
    'printf \'\\n\' >> "$tmp"',
    `install -m ${file.mode.toString(8).padStart(4, '0')} "$tmp" "$target"`,
    '',
  ].join('\n')
}
