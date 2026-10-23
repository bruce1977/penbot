import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * 最小 ZIP 写入器（deflate，无第三方依赖）。
 * 只做打包，不做加密/分卷；足够归档一篇文章目录。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function walkFiles(root, dir = root, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * 把 srcDir 整个目录打包成 destFile。路径用 / 分隔（解压后跨平台）。
 * 写入走 <destFile>.tmp → rename，避免中断后留下半截 zip。
 */
export function zipDirectory(srcDir, destFile) {
  const root = path.resolve(srcDir);
  if (!fs.existsSync(root)) throw new Error(`待打包目录不存在：${root}`);

  const entries = walkFiles(root)
    .map((file) => {
      const name = path.relative(root, file).split(path.sep).join("/");
      const raw = fs.readFileSync(file);
      const mtime = fs.statSync(file).mtime;
      return { name, raw, deflated: zlib.deflateRawSync(raw), crc: crc32(raw), mtime };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const { time, date } = dosDateTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.deflated.length, 18);
    local.writeUInt32LE(entry.raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, name, entry.deflated);

    central.push({ ...entry, name, time, date, offset });
    offset += local.length + name.length + entry.deflated.length;
  }

  const centralStart = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.deflated.length, 20);
    header.writeUInt32LE(entry.raw.length, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(entry.offset, 42);
    chunks.push(header, entry.name);
    offset += header.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  const buffer = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, destFile);
  return { file: destFile, entries: entries.length, bytes: buffer.length };
}

/** 读取 zip 内的文件名列表（用于校验/测试，不依赖外部解压工具）。 */
export function listZipEntries(zipFile) {
  const buffer = fs.readFileSync(zipFile);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`不是合法的 zip：${zipFile}`);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`zip 中央目录损坏：${zipFile}`);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** 解压 zip 内指定路径的文件内容；不存在返回 null。支持 store(0) 与 deflate(8)。 */
export function readZipEntry(zipFile, wantedName) {
  const buffer = fs.readFileSync(zipFile);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`不是合法的 zip：${zipFile}`);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`zip 中央目录损坏：${zipFile}`);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === wantedName) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`zip 条目 ${name} 使用了不支持的压缩方法 ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}
