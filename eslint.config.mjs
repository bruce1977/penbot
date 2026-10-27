// penbot 的 JS/mjs 合规检查（标准正文见 AGENTS.md「JS 代码规范」）。
// 分工：这里只放「AST 能判定」的 L1/L2/L3；配置单源、产物字段、留痕编号这类
// 判不出来的仍由 validate + 单测守，不重复实现（两处都能改同一件事 = 互相掩盖）。
import js from "@eslint/js";
import globals from "globals";
import penbot from "./scripts/lint/penbot-rules.mjs";

const SOURCES = ["scripts/**/*.mjs", "tests/**/*.mjs"];

export default [
  {
    ignores: ["node_modules/**", "output/**", "docs/**", "config/**", ".opencode/**", ".temp/**"],
  },
  js.configs.recommended,
  {
    files: SOURCES,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    plugins: { penbot },
    rules: {
      // —— L2 语法与风格（现状已一致，写成规则是防漂移）——
      indent: ["error", 2, { SwitchCase: 1 }],
      quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
      semi: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": ["error", { args: "after-used", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-undef": "error",
      "no-shadow": "error",
      "no-await-in-loop": "off",
      // Node ESM：相对 import/export 必须带 .mjs 扩展名（漏了就 ERR_MODULE_NOT_FOUND）
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.mjs$/])",
          message: "相对 import 必须带 .mjs 扩展名（Node ESM 无扩展名解析不到）。",
        },
        {
          selector:
            "ExportNamedDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.mjs$/])",
          message: "相对 export 必须带 .mjs 扩展名（Node ESM 无扩展名解析不到）。",
        },
        {
          selector:
            "ExportAllDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.mjs$/])",
          message: "相对 export * 必须带 .mjs 扩展名（Node ESM 无扩展名解析不到）。",
        },
      ],
    },
  },
  {
    // —— L1 分层：lib 是共享机制，不许反向依赖功能专属模块 ——
    files: ["scripts/lib/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/comm/*", "**/comm"],
              message: "依赖方向只允许 comm → lib（AGENTS.md：lib 不得 import comm）。",
            },
          ],
        },
      ],
      // lib 的输出一律走 createLogger（落 logs/pipeline.log），不直接写 stdout。
      "no-console": "error",
    },
  },
  {
    // createLogger 本身就是那台往 stdout/stderr 写行的机器，规则对它没有意义。
    files: ["scripts/lib/log.mjs"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // —— L3 本仓库不变量 ——
    files: ["scripts/**/*.mjs"],
    rules: {
      "penbot/trace-no-secrets": "error",
      "penbot/no-prompt-literals": ["warn", { minCjkChars: 60, exemptVariables: ["HELP"] }],
    },
  },
  {
    // 测试夹具要写违规样例与真实文案，提示词副本规则对它无意义。
    files: ["tests/**/*.mjs"],
    rules: {
      "penbot/no-prompt-literals": "off",
    },
  },
];
