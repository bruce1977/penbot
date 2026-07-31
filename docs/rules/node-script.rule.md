# Node.js 脚本编写规范

## 模块与运行环境

- 使用 `require()`（CommonJS），不使用 ESM `import`
- 无 `#!/usr/bin/env node` shebang，统一通过 `node script.js <args>` 调用
- 缩进 2 空格，编码 `utf-8`，末尾分号

## 参数解析

```js
const [,, arg1, arg2] = process.argv;
if (!arg1) {
  console.error("Usage: node script.js <arg1> [arg2]");
  process.exit(1);
}
```

- 使用解构赋值 `const [,, ...args] = process.argv`
- 参数缺失时 `console.error` + `process.exit(1)`

## 错误处理

- 同步脚本：`try/catch` + `console.error` + `process.exit(1)`
- 异步脚本：`main().catch(err => { console.error(err.message); process.exit(1); })`
- 被其他进程消费的脚本使用 JSON 错误输出：
  ```js
  console.error(JSON.stringify({ error: err.message }));
  ```
- 网络/IO 操作使用重试循环，重试次数和延迟定义为模块级常量

## 控制台输出

- 人类阅读：`console.log("msg")`，进度前缀 `MERGE`、`MOVE`、`SKIP`、`FAIL`
- 管道消费：`console.log(JSON.stringify(data))`，错误走 stderr
- 末尾输出摘要行：`` console.log(`Done. ${ok}/${total} processed`) ``

## 文件系统

- 全部使用同步 API（`readFileSync`、`writeFileSync`、`existsSync` 等）
- 目录创建前检查：`if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })`
- 路径统一用 `path.join()` / `path.resolve()`
- 跨设备 move 回退 copy+delete：
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

## 代码结构

```js
function main() {
  // 步骤 1: 解析参数
  // 步骤 2-N: 工作步骤
}
main();
```

- 异步脚本用 `async function main()` + `main().catch(...)`
- 辅助函数用 `function` 声明或 `const fn = () => { }`

## 环境变量

```js
const apiBase = process.env.PB_WECHAT_MP_API_BASE;
if (!apiBase) {
  console.error("FATAL: env VAR_NAME is not set");
  process.exit(1);
}
```

## 退出码

| 场景 | 码 |
|------|----|
| 成功 | `0`（显式或隐式） |
| 参数/环境变量缺失 | `1` |
| 运行时错误 | `1` |
| 无工作可做（空目录等） | `0` |

## 公共工具函数

提取为独立函数，不依赖外部模块：

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
  return `${d.getFullYear()}-${...}`;
}
```
