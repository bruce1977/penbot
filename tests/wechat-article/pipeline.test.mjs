import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSystemOneCfg,
  classifyByRule,
  extractTitle,
  isPublished,
  resolveInboxDir,
  stageTimeout,
} from "../../scripts/wechat-article-pipeline.mjs";

const longBody = [
  "# 深度长文标题",
  "",
  "这一段是一个完整的正文段落，字数足够多，用来说明本地规则如何识别成篇正文稿件，避免把只有提纲或零散想法的素材，误判成可以进入审稿流程的草稿。",
  "紧接着是第二段正文，同样字数可观，进一步说明它不是零散想法，而是一篇结构完整、有上下文承接、可以直接进入审稿流程的 Markdown 稿件。",
  "第三段继续补充细节，确保满足多个成段正文的判据，让 classifyByRule 能够稳定地把它判定为草稿素材而不是标题素材。",
  "第四段收尾，再次印证：判据核心是是否存在成篇连续正文，而不是简单看字数或标题数量。",
].join("\n");

test("classifyByRule：成篇正文判草稿素材", () => {
  assert.equal(classifyByRule(longBody), "draft");
});

test("classifyByRule：短标题 / 提纲式判标题素材", () => {
  assert.equal(classifyByRule("如何用好 AI 写作\n\n- 背景\n- 方法\n- 结论"), "topic");
  assert.equal(classifyByRule("一个只有标题的想法"), "topic");
});

test("extractTitle：frontmatter title 优先", () => {
  const file = "whatever.md";
  assert.equal(extractTitle('---\ntitle: "前沿洞察"\n---\n# 内文标题', file), "前沿洞察");
});

test("extractTitle：一级标题 / 首个非空行 / 文件名兜底", () => {
  assert.equal(extractTitle("# 管线编排\n\n正文", "a.md"), "管线编排");
  assert.equal(extractTitle("第一行就是标题\n\n正文", "a.md"), "第一行就是标题");
  assert.equal(extractTitle("", "my-draft.md"), "my-draft");
});

test("resolveInboxDir：未配置 BASE_INBOX_FOLDER 返回空（关闭 inbox）", () => {
  assert.equal(resolveInboxDir({}), "");
  assert.equal(resolveInboxDir({ BASE_INBOX_FOLDER: "  " }), "");
});

test("resolveInboxDir：配置后 = BASE_INBOX_FOLDER/wechat-article", () => {
  const dir = resolveInboxDir({ BASE_INBOX_FOLDER: "D:/tmp/inbox" });
  assert.equal(dir, path.join(path.resolve("D:/tmp/inbox"), "wechat-article"));
});

test("stageTimeout：缺失抛错点名配置路径", () => {
  assert.throws(() => stageTimeout({}, "draft"), /pipeline\.stage_timeouts\.draft/);
  assert.throws(() => stageTimeout({ stage_timeouts: {} }, "review"), /pipeline\.stage_timeouts\.review/);
});

test("stageTimeout：有值走 needNumber 归一", () => {
  assert.equal(stageTimeout({ stage_timeouts: { publish: "600000" } }, "publish"), 600000);
  assert.throws(() => stageTimeout({ stage_timeouts: { publish: "five" } }, "publish"), /必须是数字/);
});

test("buildSystemOneCfg：模型 id 未定义返回 null（走降级）", () => {
  assert.equal(buildSystemOneCfg({ models: {} }, "systemone.classifier"), null);
  assert.equal(buildSystemOneCfg({}, "systemone.classifier"), null);
});

test("buildSystemOneCfg：有 profile 组装端点参数", () => {
  const cfg = buildSystemOneCfg(
    {
      models: {
        "systemone.classifier": {
          base_url: "http://localhost:11434",
          endpoint: "/v1/systemone",
          model: "tev1",
          api_key: "k",
          timeout_ms: 60000,
          max_retries: 2,
        },
      },
    },
    "systemone.classifier",
  );
  assert.equal(cfg.model_id, "systemone.classifier");
  assert.equal(cfg.base_url, "http://localhost:11434");
  assert.equal(cfg.endpoint, "/v1/systemone");
  assert.equal(cfg.timeout_ms, 60000);
});

test("isPublished：05-result status=published 才算终点", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-pub-"));
  try {
    assert.equal(isPublished(dir), false);
    fs.writeFileSync(
      path.join(dir, "05-result.json"),
      JSON.stringify({ stage: "publish", status: "delivered", files: {} }),
    );
    assert.equal(isPublished(dir), false, "delivered 不是 published，不算终点");
    fs.writeFileSync(
      path.join(dir, "05-result.json"),
      JSON.stringify({ stage: "publish", status: "published", files: {} }),
    );
    assert.equal(isPublished(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
