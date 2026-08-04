// penbot ESLint plugin — project-specific rules for Node scripts.
// These encode the *semantic* conventions from docs/rules/node-script.rule.md
// that core ESLint rules cannot express. Drop new rules into `rules` below.
//
// Usage (see eslint.config.cjs):
//   const penbot = require("./tools/eslint-plugin-penbot.js");
//   plugins: { penbot },
//   rules: { "penbot/no-async-fs": "error" }

"use strict";

// fs methods that have a synchronous "XxxSync" counterpart. Any call to the
// non-Sync variant is what we forbid.
const FS_ASYNC_METHODS = [
  "readFile", "writeFile", "readdir", "mkdir", "rm", "unlink", "stat",
  "lstat", "appendFile", "copyFile", "rename", "open", "close", "access",
  "chmod", "readlink", "symlink", "truncate", "rmdir", "realpath", "writev",
  "readv", "fstat", "ftruncate", "fchmod", "fchown", "fdatasync", "fsync",
  "opendir", "mkdtemp", "cp", "lutimes", "utimes"
];

function isAsyncFsMethod(name) {
  return FS_ASYNC_METHODS.includes(name) && !name.endsWith("Sync");
}

module.exports = {
  rules: {
    "no-async-fs": {
      meta: {
        type: "problem",
        docs: {
          description: "Forbid asynchronous fs APIs in scripts; use the sync variant.",
          recommended: true
        },
        schema: [],
        messages: {
          asyncCall: "Use the synchronous fs API '{{method}}Sync' instead of async '{{method}}'.",
          promisesNs: "Do not use 'fs.promises' / 'fsPromises'; scripts must use synchronous fs.",
          promisesRequire: "Do not require 'fs/promises'; scripts must use synchronous fs."
        }
      },
      create(context) {
        function check(node) {
          const callee = node.callee;
          if (!callee || callee.type !== "MemberExpression") return;

          // require("fs/promises")
          if (
            callee.type === "MemberExpression" &&
            callee.object && callee.object.type === "Identifier" && callee.object.name === "require" &&
            callee.property && callee.property.type === "Literal" &&
            callee.property.value === "fs/promises"
          ) {
            context.report({ node: callee, messageId: "promisesRequire" });
            return;
          }

          const obj = callee.object;
          const prop = callee.property;

          // fs.promises.readFile(...)  -> fs.promises namespace
          if (
            obj.type === "MemberExpression" &&
            obj.object && obj.object.type === "Identifier" && obj.object.name === "fs" &&
            obj.property && obj.property.type === "Identifier" && obj.property.name === "promises" &&
            prop && prop.type === "Identifier"
          ) {
            context.report({ node, messageId: "promisesNs" });
            return;
          }

          // fsPromises.readFile(...)
          if (
            obj.type === "Identifier" && obj.name === "fsPromises" &&
            prop && prop.type === "Identifier"
          ) {
            context.report({ node, messageId: "promisesNs" });
            return;
          }

          // fs.readFile(...)
          if (
            obj.type === "Identifier" && obj.name === "fs" &&
            prop && prop.type === "Identifier" && isAsyncFsMethod(prop.name)
          ) {
            context.report({ node, messageId: "asyncCall", data: { method: prop.name } });
          }
        }

        return {
          CallExpression: check
        };
      }
    }
  }
};
