// 从公众号草稿箱发布文章
// 用法:
//   node scripts/publish-drafts.js                    # 直接发布全部草稿
//   node scripts/publish-drafts.js <result.json>      # 发布并将结果写入文件
//
// 凭证从环境变量读取: WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET

const fs = require('fs');
const path = require('path');

const WX = 'https://api.weixin.qq.com/cgi-bin';

function writeResult(filePath, data) {
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (_) { /* best effort */ }
}

async function getToken(appId, appSecret) {
  const url = `${WX}/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
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

async function main() {
  const [,, resultFile] = process.argv;

  const appId = process.env.WECHAT_MP_APP_ID || process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_MP_APP_SECRET || process.env.WECHAT_APP_SECRET;
  if (!appId || !appSecret) {
    const err = { error: 'WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET must be set' };
    console.error(JSON.stringify(err));
    writeResult(resultFile, { success: false, ...err, timestamp: new Date().toISOString() });
    process.exit(2);
  }

  try {
    const token = await getToken(appId, appSecret);

    const list = await listDrafts(token);
    const items = list.item_list || list.item || [];
    const drafts = items.map((it) => {
      const c = it.content || {};
      const article = (c.news_item && c.news_item[0]) || {};
      const contentText = article.content || '';
      return {
        media_id: it.media_id,
        title: article.title || c.title || '(无标题)',
        create_time: c.create_time ? new Date(c.create_time * 1000).toISOString() : '?',
        hasContent: !!contentText.trim(),
      };
    });

    const results = [];
    for (const d of drafts) {
      if (!d.hasContent) {
        results.push({ title: d.title, media_id: d.media_id, status: 'skipped_empty' });
        continue;
      }
      try {
        const r = await publishDraft(token, d.media_id);
        results.push({ title: d.title, media_id: d.media_id, status: 'published', publish_id: r.publish_id });
      } catch (e) {
        results.push({ title: d.title, media_id: d.media_id, status: 'error', msg: e.message });
      }
    }

    const published = results.filter(r => r.status === 'published').length;
    const failed = results.filter(r => r.status === 'error').length;
    const skipped = results.filter(r => r.status === 'skipped_empty').length;
    const output = {
      success: failed === 0,
      total: drafts.length,
      published,
      skipped,
      failed,
      results,
      timestamp: new Date().toISOString(),
    };

    writeResult(resultFile, output);
    console.log(JSON.stringify(output));

    if (failed > 0) process.exit(1);
  } catch (e) {
    const err = { success: false, error: e.message, timestamp: new Date().toISOString() };
    writeResult(resultFile, err);
    console.error(JSON.stringify(err));
    process.exit(1);
  }
}

main();
