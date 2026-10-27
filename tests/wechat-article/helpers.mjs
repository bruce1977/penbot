// 各阶段测试文件共享的临时目录 helper
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rawConfig(knowledgeDir) {
  return {
    project: {},
    models: { local: { provider: "mock" } },
    defaults: {
      model: "local",
      // 只放 correct_cn.base_url：其余运行时参数（轮次/通过线/检索条数/配图区间/投递端点）
      // 加载期不再注入同值默认，需要它们的测试自己按段落补齐（见 infra.test.mjs 的透传断言）。
      review: { correct_cn: { base_url: "http://localhost" } },
      knowledge: {},
      illustrations: {},
      publish: {},
    },
    types: [
      {
        id: "t1",
        name: "T1",
        knowledge_dirs: [knowledgeDir],
        model: "local",
        length: { min: 100, max: 200, target: 150 },
        // style.tone / audience / title_style 是提示词直接引用的必填项（validateConfig 会缺项报错，
        // 去 AI 化读 tone 时缺了直接抛错），所以夹具类型一律补齐。
        style: { tone: "冷静", audience: "技术读者", title_style: "直述" },
        scoring: {
          pass_score: 80,
          dimensions: [
            { id: "a", name: "A", weight: 1 },
            { id: "b", name: "B", weight: 3 },
          ],
        },
        review: {},
        illustrations: {},
        topic: {},
      },
    ],
  };
}
