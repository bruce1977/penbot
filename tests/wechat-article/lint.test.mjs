// Lint 标准自身的测试：本仓库不变量（自定义规则）必须真的能报，
// 分层与命名约束（L1）除靠 eslint.config.mjs 外，这里再对真实文件结构断言一次。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import penbot from "../../scripts/lint/penbot-rules.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const linter = new Linter();

function run(code, rules) {
  return linter.verify(code, {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { penbot },
    rules,
  });
}

// 63 个中文字符的成句文案：超过默认阈值 60，够触发规则。
const LONG_PROMPTISH =
  "文章开头不要使用套话，结尾要给出可执行的结论，论述保持连贯，每一段都只说一件事，不要重复出现相同的过渡句式，也不要使用夸张的排比来凑字数。";

test("no-prompt-literals：成句中文文案抄进代码要报", () => {
  const msgs = run(`const a = ${JSON.stringify(LONG_PROMPTISH)};`, {
    "penbot/no-prompt-literals": ["error", { minCjkChars: 60, exemptVariables: ["HELP"] }],
  });
  assert.deepEqual(msgs.map((m) => m.messageId), ["promptCopy"]);
  assert.match(msgs[0].message, /prompts\/\*\.yaml/);

  // 模板字符串同样计入（拼进去的静态片段一起数）
  const tpl = run("const b = `" + LONG_PROMPTISH + "`;", {
    "penbot/no-prompt-literals": ["error", { minCjkChars: 60 }],
  });
  assert.deepEqual(tpl.map((m) => m.messageId), ["promptCopy"]);

  // 短句（报错定位、字段备注）不该被误伤
  assert.equal(
    run('const s = "字段 sections 缺失";', { "penbot/no-prompt-literals": ["error", { minCjkChars: 60 }] }).length,
    0,
  );
});

test("no-prompt-literals：报错/日志/帮助文本语境豁免", () => {
  const rules = { "penbot/no-prompt-literals": ["error", { minCjkChars: 60, exemptVariables: ["HELP"] }] };
  const exempt = [
    `throw new Error(${JSON.stringify(LONG_PROMPTISH)});`,
    `const HELP = ${JSON.stringify(LONG_PROMPTISH)};`,
    `log.info(${JSON.stringify(LONG_PROMPTISH)});`,
    `logger.warn(${JSON.stringify(LONG_PROMPTISH)});`,
    `console.log(${JSON.stringify(LONG_PROMPTISH)});`,
    `needConfig(x, ${JSON.stringify(LONG_PROMPTISH)});`,
    `pickPromptText(p, ${JSON.stringify(LONG_PROMPTISH)});`,
  ];
  for (const code of exempt) {
    assert.deepEqual(run(code, rules).map((m) => m.messageId), [], code.slice(0, 40));
  }
});

test("trace-no-secrets：留痕载荷里的鉴权字段与读取都报", () => {
  const rules = { "penbot/trace-no-secrets": "error" };
  const hits = [
    ["record({ label, request: { api_key: key } });", "secretKey"],
    ["record({ label, request: { authorization: cfg.authorization } });", ["secretKey", "secretRead"]],
    ['record({ label, request: { headers: { "X-Auth-Key": v } } });', "secretKey"],
    ["recorder.record({ label, request: { accessToken: t } });", "secretKey"],
    ["record({ label, request: { password: p } });", "secretKey"],
  ];
  for (const [code, expect] of hits) {
    const got = run(code, rules).map((m) => m.messageId);
    const want = Array.isArray(expect) ? expect : [expect];
    assert.deepEqual(got, want, code);
  }

  // 干净留痕不报：摘要、文件名、redact 之后的文案
  const clean = [
    "record({ label, request: { prompt, model }, response: redact(text) });",
    "record({ label, request: { html_chars: html.length, attachments: names } });",
    "record({ label, response: body.slice(0, 500) });",
  ];
  for (const code of clean) {
    assert.deepEqual(run(code, rules), [], code);
  }

  // 不在 record 调用里的同名字段不算留痕（普通请求构造本来就要读 key）
  assert.deepEqual(
    run("const headers = { Authorization: `Bearer ${apiKey}` };", rules),
    [],
    "非留痕语境不该被这条规则管",
  );

  // extraKeys 允许调用方补本仓库特有的字段名
  assert.deepEqual(
    run("record({ label, request: { wechat_app_secret: s } });", {
      "penbot/trace-no-secrets": ["error", { extraKeys: ["wechat_app_secret"] }],
    }).map((m) => m.messageId),
    ["secretKey"],
  );
});

test("L1：scripts/lib 不 import comm，scripts/comm 文件名带功能前缀", () => {
  const list = (dir) =>
    fs.existsSync(dir)
      ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
        .map((e) => path.join(dir, e.name))
      : [];

  for (const file of list(path.join(repoRoot, "scripts/lib"))) {
    const code = fs.readFileSync(file, "utf8");
    const offenders = [...code.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((m) => m[1])
      .filter((spec) => /(^|\/)comm\//.test(spec));
    assert.deepEqual(offenders, [], `${path.basename(file)} 反向依赖了 comm（只允许 comm → lib）`);
  }

  const prefixes = ["wechat-"];
  for (const file of list(path.join(repoRoot, "scripts/comm"))) {
    const name = path.basename(file);
    assert.ok(
      prefixes.some((p) => name.startsWith(p)),
      `comm 模块 ${name} 必须以功能前缀命名（AGENTS.md 目录规范）`,
    );
  }
});

test("L1：comm 模块只被所属管线入口与测试引用", () => {
  const commDir = path.join(repoRoot, "scripts/comm");
  if (!fs.existsSync(commDir)) return;
  const importersOf = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "output", ".temp", ".git", ".opencode", "docs"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) {
        const code = fs.readFileSync(full, "utf8");
        for (const m of code.matchAll(/from\s+["']([^"']*\/comm\/[^"']+)["']/g)) {
          const base = path.basename(m[1]);
          if (!importersOf.has(base)) importersOf.set(base, []);
          importersOf.get(base).push(path.relative(repoRoot, full).replaceAll("\\", "/"));
        }
      }
    }
  };
  walk(repoRoot);

  for (const [mod, files] of importersOf) {
    for (const file of files) {
      const ok = /^scripts\/wechat-article\.mjs$/.test(file) || /^tests\//.test(file);
      assert.ok(ok, `${mod} 被 ${file} 引用：comm 模块只允许所属管线入口与测试引用`);
    }
    assert.ok(/^wechat-/.test(mod), `${mod} 归属的管线前缀无法识别`);
  }
});
