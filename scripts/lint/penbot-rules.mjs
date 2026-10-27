// penbot 自定义 ESLint 规则（本地插件，不发包）：只查「AGENTS.md 写了、且 AST 能判定」的不变量。
// 判不出来的（配置读取端不留同值兜底、产物字段单源）不进 lint，留给单测与 validate——
// 规则查不动却配着，本身就是配置说谎。
//   trace-no-secrets   留痕载荷不许出现鉴权字段（AGENTS.md：NN-step/api/ 绝不含 API key / Authorization）
//   no-prompt-literals 成句中文文案不许抄进代码（AGENTS.md：提示词全文单源 prompts/*.yaml）
const SECRET_KEY = /^(api_?key|apikey|authorization|proxy-authorization|x-auth-key|access_?token|refresh_?token|secret|secret_?key|password|passwd)$/i;
const SECRET_READ = /^(api_?key|apikey|authorization|secret|secret_?key|password|passwd|token|access_?token)$/i;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

// 报错定位、CLI 输出、帮助文本本来就该是中文，不是「提示词副本」。
const MESSAGE_CALLEES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "needConfig",
  "needNumber",
  "needProfile",
  "needEndpointParam",
  "needGateParam",
  "where",
  "pickPromptText",
  "log",
  "info",
  "warn",
  "error",
  "step",
  "debug",
  "trace",
]);

function calleeName(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  return "";
}

function isRecordCall(node) {
  return node.type === "CallExpression" && calleeName(node.callee) === "record";
}

function cjkLength(text) {
  const matched = String(text).match(CJK);
  return matched ? matched.length : 0;
}

/** 模板串拼成静态可读文本（表达式位上的字符串字面量也算进来）。 */
function templateText(node) {
  const parts = [];
  for (let i = 0; i < node.quasis.length; i++) {
    parts.push(node.quasis[i].value.cooked ?? node.quasis[i].value.raw);
    const expr = node.expressions[i];
    if (expr?.type === "Literal" && typeof expr.value === "string") parts.push(expr.value);
  }
  return parts.join("");
}

/** 从内层往外看这条字面量是不是在「报错 / 打日志 / 帮助文本」语境里。 */
function insideMessageContext(ancestors, exemptVariables) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node.type === "ThrowStatement") return true;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && exemptVariables.has(node.id.name)) {
      return true;
    }
    if (node.type === "NewExpression" && MESSAGE_CALLEES.has(calleeName(node.callee))) return true;
    if (node.type === "CallExpression") {
      const name = calleeName(node.callee);
      if (MESSAGE_CALLEES.has(name)) return true;
      if (node.callee?.type === "MemberExpression" && node.callee.object?.name === "console") return true;
    }
  }
  return false;
}

export const rules = {
  "trace-no-secrets": {
    meta: {
      type: "problem",
      schema: [
        {
          type: "object",
          properties: { extraKeys: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
      ],
      messages: {
        secretKey: "留痕载荷不许出现鉴权字段 {{name}}（AGENTS.md：NN-step/api/ 绝不含 API key / Authorization）。",
        secretRead: "留痕不许把鉴权值读进 {{name}}：只允许 redact() 之后的文案或摘要数字。",
      },
    },
    create(context) {
      const extraKeys = (context.options[0]?.extraKeys || []).map((pattern) => new RegExp(pattern, "i"));
      const sourceCode = context.sourceCode;

      function withinRecord(node) {
        return sourceCode.getAncestors(node).some(isRecordCall);
      }

      function propertyName(property) {
        if (property.key?.type === "Identifier") return property.key.name;
        if (property.key?.type === "Literal") return String(property.key.value);
        return "";
      }

      return {
        Property(node) {
          const name = propertyName(node);
          if (!name || !withinRecord(node)) return;
          if (SECRET_KEY.test(name) || extraKeys.some((re) => re.test(name))) {
            context.report({ node, messageId: "secretKey", data: { name } });
          }
        },
        MemberExpression(node) {
          if (!withinRecord(node) || node.computed) return;
          const name = node.property?.name || "";
          if (!SECRET_READ.test(name)) return;
          // 键名列表/注释用途的字符串值不算读取（如 redact 的 flag 名单）。
          if (node.parent.type === "Property" && node.parent.key === node) return;
          context.report({ node, messageId: "secretRead", data: { name } });
        },
      };
    },
  },

  "no-prompt-literals": {
    meta: {
      type: "suggestion",
      schema: [
        {
          type: "object",
          properties: {
            minCjkChars: { type: "integer", minimum: 10 },
            exemptVariables: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      ],
      messages: {
        promptCopy:
          "代码里出现 {{cjk}} 个中文字符的成句文案（{{kind}}）：提示词与整句文案单源 config/*/prompts/*.yaml，代码只按条件挑 key（AGENTS.md）。",
      },
    },
    create(context) {
      const options = context.options[0] || {};
      const min = options.minCjkChars ?? 60;
      const exemptVariables = new Set(options.exemptVariables || []);
      const sourceCode = context.sourceCode;

      function check(node, text, kind) {
        if (cjkLength(text) < min) return;
        if (insideMessageContext(sourceCode.getAncestors(node), exemptVariables)) return;
        context.report({ node, messageId: "promptCopy", data: { cjk: cjkLength(text), kind } });
      }

      return {
        Literal(node) {
          if (typeof node.value === "string") check(node, node.value, "字符串字面量");
        },
        TemplateLiteral(node) {
          check(node, templateText(node), "模板字符串");
        },
      };
    },
  },
};

export default { rules };
