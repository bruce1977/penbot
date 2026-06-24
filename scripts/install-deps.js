const { spawn } = require('child_process');
const { resolve, relative, sep } = require('path');
const { existsSync, readdirSync, statSync } = require('fs');

const ROOT = resolve(__dirname, '..');

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
      shell: true,
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
  console.log(`Found ${dirs.length} package.json directories\n`);

  let ok = 0, fail = 0;
  for (const dir of dirs) {
    if (await install(dir)) ok++; else fail++;
  }

  console.log(`\nDone — ${ok} succeeded, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
