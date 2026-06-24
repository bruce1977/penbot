const https = require('https');
const fs = require('fs');
const path = require('path');

function sendMail(apiKey, fromDisplay, to, subject, htmlContent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: fromDisplay,
      to: [to],
      subject: subject,
      html: htmlContent,
    });

    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 20000,
      },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode === 200) {
            resolve({ success: true, id: parsed.id });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  const [,, to, subject, htmlPath] = process.argv;

  if (!to || !subject || !htmlPath) {
    console.error('Usage: node send.js <to> <subject> <html-file-path>');
    process.exit(1);
  }

  const apiKey = process.env.PB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('Error: RESEND_API_KEY not set (try PB_RESEND_API_KEY)');
    process.exit(1);
  }

  const fromAddr = process.env.PB_RESEND_FROM || 'penbot@myehome.cn';
  const fromDisplay = `公众号汇集小能手 <${fromAddr}>`;
  const htmlContent = fs.readFileSync(path.resolve(htmlPath), 'utf-8');

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      console.log(`Retry ${attempt}/3 after error: ${lastErr.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
    try {
      const result = await sendMail(apiKey, fromDisplay, to, subject, htmlContent);
      console.log(JSON.stringify(result));
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(JSON.stringify({ error: lastErr.message }));
  process.exit(1);
}

main();
