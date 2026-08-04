# Node.js 脚本编写规范

本规范约束项目内所有 `scripts/` 及技能下 `scripts/` 目录里的 `.js` 脚本。
每条规则标注强制等级：

- **[Lint-自动]** —— 由 ESLint 核心规则自动检查（`eslint.config.cjs`）
- **[Lint-自定义]** —— 由本项目 ESLint 插件 `tools/eslint-plugin-penbot.js` 检查
- **[评审]** —— 无法靠 linter 表达，需人工代码评审

> 运行检查：`npm run lint`（仅检查） / `npm run lint:fix`（自动修复可修复项）。
> 作用范围：`scripts/**/*.js` 与 `skills/knowledge/scripts/**/*.js`。

---

## 1. 模块与运行环境  [Lint-自动]

- 使用 `require()`（CommonJS），**禁止** ESM `import` / `export`。
  （`eslint.config.cjs` 设 `sourceType: "commonjs"`，`import`/`export` 直接报解析错误。）
- 无 `#!/usr/bin/env node` shebang，统一通过 `node script.js <args>` 调用。
- 文件末尾不留悬空可执行代码：库文件用 `if (require.main === module) { ... }` 守卫 CLI 入口。
- 编码 `utf-8`，文件结尾保留一个换行符。

## 2. 代码格式  [Lint-自动]

- 缩进 **2 空格**，末尾 **分号**。
- 字符串使用 **双引号**（`"..."`）；仅当字符串内含双引号、转义更丑时可用单引号。
- 使用 `const` / `let`，**禁止 `var`**。
- 比较用 `===`；允许 `== null` 惯用法（同时判空与未定义）。
- 优先 `const`；只有需要重新赋值时才用 `let`。

## 3. 参数解析  [评审 + 模板]

```js
const [,, arg1, arg2] = process.argv;
if (!arg1) {
  console.error("Usage: node script.js <arg1> [arg2]");
  process.exit(1);
}
```

- 用解构 `const [,, ...args] = process.argv` 取参。
- 参数缺失时：`console.error("Usage: ...")` + `process.exit(1)`。

## 4. 环境变量  [评审 + 模板]

```js
const apiBase = process.env.PB_WECHAT_MP_API_BASE;
if (!apiBase) {
  console.error("FATAL: env PB_WECHAT_MP_API_BASE is not set");
  process.exit(1);
}
```

- 必填环境变量缺失时：`console.error("FATAL: env VAR is not set")` + `process.exit(1)`。

## 5. 错误处理  [评审]

- 同步脚本：`try/catch` + `console.error` + `process.exit(1)`。
- 异步脚本：`main().catch(err => { console.error(err.message); process.exit(1); })`。
- 被其他进程消费的脚本：错误走 `console.error(JSON.stringify({ error: err.message }))`，不混用人类阅读文本。
- 网络 / IO 操作使用重试循环；重试次数与延迟定义为**模块级常量**（如 `MAX_RETRIES`、`REQUEST_TIMEOUT_MS`），不要写死在调用处。

## 6. 文件系统  [Lint-自定义: penbot/no-async-fs]

- **全部使用同步 API**：`readFileSync` / `writeFileSync` / `existsSync` / `mkdirSync` / `readdirSync` / `renameSync` / `rmSync` 等。
- **禁止**以下异步变体（插件会直接报错）：
  - `fs.readFile` / `fs.writeFile` / `fs.readdir` / `fs.mkdir` / `fs.rm` / `fs.unlink` / `fs.stat` / `fs.rename` / `fs.cp` …（及其 `fs.promises.*`、`fsPromises.*` 形式）
  - `require("fs/promises")`
- 目录创建前先检查：`if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })`。
- 路径统一用 `path.join()` / `path.resolve()`，不要手拼字符串。
- 跨设备 `move` 回退 `copy` + `delete`（捕获 `EXDEV`）：

  ```js
  function moveFile(src, dst) {
    try { fs.renameSync(src, dst); }
    catch (err) {
      if (err.code === "EXDEV") {
        fs.writeFileSync(dst, fs.readFileSync(src));
        fs.unlinkSync(src);
      } else throw err;
    }
  }
  ```

## 7. 控制台输出  [评审 / 可扩展]

- 人类阅读：`console.log("msg")`；进度前缀用 `MERGE` / `MOVE` / `SKIP` / `FAIL`。
- 管道消费：`console.log(JSON.stringify(data))`；错误走 stderr。
- 末尾输出摘要行：`console.log(\`Done. ${ok}/${total} processed\`)`。
- （可选扩展：可用自定义规则强制 `console.log` 首参以已知前缀开头，目前为 [评审]。）

## 8. 代码结构  [评审]

```js
function main() {
  // 步骤 1: 解析参数
  // 步骤 2-N: 工作步骤
}
main();
```

- CLI 入口脚本：定义 `function main()`（异步用 `async function main()` + `main().catch(...)`）后调用。
- 库文件（被其它脚本 `require`）：导出处理函数 `module.exports = { processFile }`，并在底部加 `if (require.main === module) { ... }` CLI 守卫。
- **`main` 只描述主干**：解析参数 → 获取待处理列表 → 循环调用处理函数 → 输出摘要。循环体内的单条目逻辑（校验 / 读取 / 转换 / 写入）必须抽到独立函数（如 `processFile`、`handleItem`），`main` 中只保留调用与计数。
- 公共工具函数（如 `loadJSON` / `safeRead` / `fmtDate`）提取为独立函数，不依赖外部模块：

  ```js
  function loadJSON(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
  }
  function safeRead(fp) {
    try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; }
  }
  function fmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  ```

## 9. 退出码  [评审]

| 场景 | 码 |
|------|----|
| 成功 | `0`（显式或隐式） |
| 参数 / 环境变量缺失 | `1` |
| 运行时错误 | `1` |
| 无工作可做（空目录等） | `0` |

## 10. 静态检查（ESLint）  [工具]

配置见根目录 `eslint.config.cjs`（flat config，CommonJS）。

- **命令**：`npm run lint` / `npm run lint:fix`
- **范围**：`scripts/**/*.js` 与 `skills/knowledge/scripts/**/*.js`
- **核心规则（已编码）**：
  - `sourceType: "commonjs"` —— 禁 ESM `import`/`export`
  - `indent: 2`、`semi: always`、`quotes: double`
  - `no-var`、`prefer-const`、`eqeqeq`（`null` 豁免）
  - `no-unused-vars`、`no-undef`
- **自定义插件规则**（`tools/eslint-plugin-penbot.js`）：
  - `penbot/no-async-fs`（error）—— 禁止异步 fs，强制同步 API（对应第 6 节）
- **扩展方式**：在 `eslint.config.cjs` 的 `files` 数组加目录即可扩大范围；插件新增规则只需在 `tools/eslint-plugin-penbot.js` 的 `rules` 里追加，再在 config 的 `rules` 启用。
- **注意**：第 3/4/5/7/8/9 节的语义约定 linter 无法表达，仍需代码评审；标记为 [Lint-自定义] 的条目可随插件规则增多逐步转为自动检查。
