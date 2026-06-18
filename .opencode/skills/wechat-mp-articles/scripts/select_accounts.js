const fs = require("fs");

const [,, configPath, dateStr, outputPath] = process.argv;
if (!configPath || !dateStr || !outputPath) {
  console.error("Usage: node select_accounts.js <config.json> <date> <output.json>");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const maxAccounts = config.settings.max_accounts || 5;

const enabledAccounts = config.accounts
  .filter(a => a.enabled !== false)
  .sort((a, b) => a.name.localeCompare(b.name));

const total = enabledAccounts.length;
if (total === 0) {
  console.error("No enabled accounts found in config");
  process.exit(1);
}

const date = new Date(dateStr);
if (isNaN(date.getTime())) {
  console.error(`Invalid date: "${dateStr}". Expected format: YYYY-MM-DD`);
  process.exit(1);
}

const msPerDay = 86400000;
const epoch = new Date("2020-01-01");
const daysSinceEpoch = Math.floor((date - epoch) / msPerDay);

const numGroups = Math.ceil(total / maxAccounts);
const cycleIndex = Math.floor(daysSinceEpoch / numGroups);
const groupIndex = daysSinceEpoch % numGroups;

function seededShuffle(arr, seed) {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = ((s * 1664525 + 1013904223) & 0x7fffffff) >>> 0;
    const j = s % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const ordered = cycleIndex === 0
  ? enabledAccounts
  : seededShuffle(enabledAccounts, cycleIndex);

const start = groupIndex * maxAccounts;
const end = Math.min(start + maxAccounts, total);
let selected = ordered.slice(start, end);

// 如果当前日期选中的账号数不足最大数，且公众号池总量足够，从列表头部补充（下一轮）
if (selected.length < maxAccounts && total >= maxAccounts) {
  const needed = maxAccounts - selected.length;
  const wrap = ordered.slice(0, needed);
  selected = selected.concat(wrap);
}

const result = {
  date: dateStr,
  max_accounts: maxAccounts,
  total_enabled: total,
  num_groups: numGroups,
  cycle_index: cycleIndex,
  group_index: groupIndex,
  selected_count: selected.length,
  accounts: selected
};

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
console.log(`Selected ${selected.length}/${total} accounts for ${dateStr} -> ${outputPath}`);
