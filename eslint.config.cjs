// ESLint flat config for penbot.
// Encodes docs/rules/node-script.rule.md into lintable rules.
// Scoped to the project's authored Node scripts (root scripts/ and the
// knowledge skill scripts). Extend the `files` globs to cover more
// skill scripts if desired (note: many bundled skill assets are third-party
// and will produce a lot of noise).

const globals = require("globals");
const penbot = require("./tools/eslint-plugin-penbot.js");

module.exports = [
  {
    // Global ignores so the linter never wanders into deps/temp output.
    ignores: [
      "**/node_modules/**",
      "local-mcps/**",
      ".temp/**",
      "output/**",
      "**/dist/**"
    ]
  },
  {
    name: "penbot/node-scripts",
    files: [
      "scripts/**/*.js",
      "skills/knowledge/scripts/**/*.js"
    ],
    languageOptions: {
      // CommonJS: forbids ESM `import`/`export` (rule: use require()).
      sourceType: "commonjs",
      ecmaVersion: 2023,
      globals: {
        ...globals.node
      }
    },
    plugins: {
      penbot
    },
    rules: {
      // --- Style rules from node-script.rule.md ---
      "indent": ["error", 2, { SwitchCase: 1 }],
      "semi": ["error", "always"],          // 末尾分号
      "quotes": ["error", "double", { avoidEscape: true }],

      // --- Modern syntax preferences ---
      "no-var": "error",                     // prefer const/let
      "prefer-const": "warn",
      "eqeqeq": ["error", "always", { null: "ignore" }], // allow `== null` idiom
      "no-unused-vars": ["warn", { args: "none", vars: "all" }],

      // --- Robustness ---
      "no-undef": "error",

      // --- Project-specific semantic rules (tools/eslint-plugin-penbot.js) ---
      "penbot/no-async-fs": "error"          // forbid async fs; require sync API
    }
  }
];
