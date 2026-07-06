const { spawn } = require('child_process');
const { resolve, relative } = require('path');
const { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } = require('fs');

const ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');
const CONFIGS_DIR = resolve(ROOT, 'configs');
const TEST_CONFIG_PATH = resolve(CONFIGS_DIR, 'test-config.json');

const REQUIRED_ENV_VARS = [
  'PB_WECHAT_MP_AUTH_KEY',
  'PB_WECHAT_MP_API_BASE',
  'PB_PYCORRECTOR_API_URL',
  'PB_PYCORRECTOR_AUTH_KEY',
  'PB_MODEL_API_KEY',
  'PB_IMAGE_GENERATION_URL',
  'PB_RESEND_API_KEY',
  'PB_RESEND_FROM',
  'WECHAT_MP_APP_ID',
  'WECHAT_MP_APP_SECRET',
];

const TEST_CONFIG_TEMPLATE = {
  settings: {
    name: 'test',
    days_to_filter: 3,
    max_articles_per_account: 3,
    max_accounts: 2,
    top_n_articles: 5,
    topic_count: 3,
    topic_selection_guidance: '关注AI行业热点，优先选取技术突破、产品发布与投融资相关的主题',
    similarity_threshold: 0.8,
    language: 'zh-CN',
    email: '',
    email_summary_enabled: true,
    email_final_enabled: true,
  },
  accounts: [
    {
      name: '示例公众号',
      fake_id: 'MzIznjc1nzUzmw==',
      category: '行业媒体',
      enabled: true,
    },
  ],
};

function ensureEnvFile() {
  if (existsSync(ENV_PATH)) {
    console.log('  ✓ .env already exists, skipping');
    return;
  }
  const lines = REQUIRED_ENV_VARS.map(v => `${v}=`);
  const content = lines.join('\n') + '\n';
  writeFileSync(ENV_PATH, content, 'utf8');
  console.log(`  ✓ Created .env with ${REQUIRED_ENV_VARS.length} environment variables (empty values)`);
}

function ensureTestConfig() {
  if (existsSync(CONFIGS_DIR)) {
    if (existsSync(TEST_CONFIG_PATH)) {
      console.log('  ✓ configs/test-config.json already exists, skipping');
      return;
    }
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG_TEMPLATE, null, 2) + '\n', 'utf8');
    console.log('  ✓ Created configs/test-config.json');
    return;
  }
  mkdirSync(CONFIGS_DIR, { recursive: true });
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG_TEMPLATE, null, 2) + '\n', 'utf8');
  console.log('  ✓ Created configs/ directory and test-config.json');
}

const dirs = [
  ...discoverPackageDirs(resolve(ROOT, 'skills')),
  ...discoverPackageDirs(resolve(ROOT, 'local-mcps')),
];

function discoverPackageDirs(parent) {
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .map(name => resolve(parent, name))
    .filter(p => statSync(p).isDirectory() && existsSync(resolve(p, 'package.json')));
}

async function install(dir) {
  const label = relative(ROOT, dir) || '.';
  return new Promise((resolvePromise) => {
    const proc = spawn('npm', ['install', '--ignore-scripts'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let output = '';
    proc.stdout.on('data', chunk => output += chunk);
    proc.stderr.on('data', chunk => output += chunk);

    proc.on('close', code => {
      if (code === 0) {
        console.log(`  ✓ ${label}`);
        resolvePromise(true);
      } else {
        const lastLine = output.trim().split('\n').slice(-3).join('\n');
        console.log(`  ✗ ${label} (exit ${code})`);
        if (lastLine) console.log(`    ${lastLine}`);
        resolvePromise(false);
      }
    });
  });
}

async function main() {
  console.log('--- Environment ---');
  ensureEnvFile();

  console.log('--- Config ---');
  ensureTestConfig();

  console.log('--- Dependencies ---');
  console.log(`Found ${dirs.length} package.json directories\n`);

  let ok = 0, fail = 0;
  for (const dir of dirs) {
    if (await install(dir)) ok++; else fail++;
  }

  console.log(`\nDone — ${ok} succeeded, ${fail} failed`);
  if (fail > 0 && ok === 0) process.exit(1);
}

main();
