// 微信公众号草稿箱自动发布脚本
// 用法:
//   node scripts/wechat-publish-drafts.mjs          # 只读列出草稿（DRY_RUN）
//   DRY_RUN=0 node scripts/wechat-publish-drafts.mjs # 真正发布全部非空草稿
//
// 依赖: Node >= 18 (全局 fetch)，凭证从项目根目录 .env 读取
//   WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const env = {};
if (fs.existsSync(ENV_PATH)) {
  for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
}

const APP_ID = env.WECHAT_MP_APP_ID;
const APP_SECRET = env.WECHAT_MP_APP_SECRET;
const DRY_RUN = process.env.DRY_RUN !== '0';

if (!APP_ID || !APP_SECRET) {
  console.error('缺少 WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET（检查项目根目录 .env）');
  process.exit(2);
}

const WX = 'https://api.weixin.qq.com/cgi-bin';

async function getToken() {
  const url = `${WX}/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.errcode) throw new Error(`获取 access_token 失败: ${j.errcode} ${j.errmsg}`);
  return j.access_token;
}

async function listDrafts(token, offset = 0, count = 20) {
  const r = await fetch(`${WX}/draft/batchget?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset, count }),
  });
  const j = await r.json();
  if (j.errcode) throw new Error(`读取草稿箱失败: ${j.errcode} ${j.errmsg}`);
  return j;
}

async function publishDraft(token, mediaId) {
  const r = await fetch(`${WX}/freepublish/submit?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: mediaId }),
  });
  const j = await r.json();
  if (j.errcode) throw new Error(`发布失败(${mediaId}): ${j.errcode} ${j.errmsg}`);
  return j;
}

(async () => {
  console.log(`[1/3] 获取 access_token ... APP_ID=${APP_ID}`);
  const token = await getToken();
  console.log('      ✅ token 获取成功');

  console.log('[2/3] 读取草稿箱 ...');
  const list = await listDrafts(token);
  const items = list.item_list || list.item || [];
  console.log(`      草稿总数: ${list.total_count ?? items.length}, 本次返回: ${items.length}`);

  const drafts = items.map((it, i) => {
    const c = it.content || {};
    const article = (c.news_item && c.news_item[0]) || {};
    const contentText = article.content || '';
    return {
      idx: i + 1,
      media_id: it.media_id,
      title: article.title || c.title || '(无标题)',
      create_time: c.create_time ? new Date(c.create_time * 1000).toISOString() : '?',
      hasContent: !!contentText.trim(),
    };
  });
  for (const d of drafts) {
    console.log(`      ${d.idx}. [${d.media_id}] "${d.title}" 创建:${d.create_time} 内容:${d.hasContent ? '有' : '空'}`);
  }

  if (DRY_RUN) {
    console.log('\n[3/3] DRY_RUN 模式：仅列出，未发布。设置 DRY_RUN=0 重新运行以真正发布。');
    process.exit(0);
  }

  console.log(`[3/3] 开始发布 ${drafts.length} 篇草稿 ...`);
  const results = [];
  for (const d of drafts) {
    if (!d.hasContent) {
      console.log(`      ⏭️  跳过 "${d.title}"：内容为空，疑似占位草稿`);
      results.push({ title: d.title, status: 'skipped_empty' });
      continue;
    }
    try {
      const r = await publishDraft(token, d.media_id);
      console.log(`      ✅ 已发布 "${d.title}" publish_id=${r.publish_id}`);
      results.push({ title: d.title, status: 'published', publish_id: r.publish_id });
    } catch (e) {
      console.error(`      ❌ ${e.message}`);
      results.push({ title: d.title, status: 'error', msg: e.message });
    }
  }
  const published = results.filter((r) => r.status === 'published').length;
  const failed = results.filter((r) => r.status === 'error').length;
  const skipped = results.filter((r) => r.status === 'skipped_empty').length;
  console.log(`\n汇总：共 ${drafts.length} 篇 → 发布 ${published}，跳过 ${skipped}，失败 ${failed}`);
})().catch((e) => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
