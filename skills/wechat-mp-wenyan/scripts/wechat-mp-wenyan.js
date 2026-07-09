const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function writeResult(filePath, data) {
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (_) { /* best effort */ }
}

function main() {
  const [,, inputMd, resultFile] = process.argv;

  if (!inputMd) {
    console.error('Usage: node publish.js <input.md> [result.json]');
    process.exit(1);
  }

  const resolvedPath = path.resolve(inputMd);

  if (!fs.existsSync(resolvedPath)) {
    const err = { error: `File not found: ${resolvedPath}` };
    console.error(JSON.stringify(err));
    writeResult(resultFile, { success: false, ...err, timestamp: new Date().toISOString() });
    process.exit(1);
  }

  const appId = process.env.WECHAT_MP_APP_ID || process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_MP_APP_SECRET || process.env.WECHAT_APP_SECRET;
  if (!appId || !appSecret) {
    const err = { error: 'WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET (or WECHAT_APP_ID / WECHAT_APP_SECRET) must be set' };
    console.error(JSON.stringify(err));
    writeResult(resultFile, { success: false, ...err, timestamp: new Date().toISOString() });
    process.exit(1);
  }

  try {
    const output = execSync(
      `npx @wenyan-md/cli publish -f "${resolvedPath}"`,
      {
        env: {
          ...process.env,
          WECHAT_APP_ID: appId,
          WECHAT_APP_SECRET: appSecret,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      }
    );
    const draftId = output.stdout ? output.stdout.toString().trim() : 'published';
    const result = { success: true, draft_id: draftId, timestamp: new Date().toISOString() };
    writeResult(resultFile, result);
    console.log(JSON.stringify(result));
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    const result = { success: false, error: err.message, stderr, stdout, timestamp: new Date().toISOString() };
    writeResult(resultFile, result);
    console.error(JSON.stringify(result));
    process.exit(1);
  }
}

main();
