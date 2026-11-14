const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const LOG_DIR = path.resolve(__dirname, "logs");
// Keep current calendar month + previous month as daily .log files
const KEEP_LOOSE_MONTHS = 1;
// Keep monthly zips for this many calendar months (including current)
const RETENTION_MONTHS = 6;

let outputBuffer = [];
let tableBuffer = [];
let runFailed = false;
let finalized = false;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

/** Shift a YYYY-MM key by delta months (negative = past). */
function shiftMonthKey(yyyyMm, deltaMonths) {
  const [y, m] = yyyyMm.split("-").map(Number);
  return monthKey(new Date(Date.UTC(y, m - 1 + deltaMonths, 1)));
}

/** Months strictly older than (current - KEEP_LOOSE_MONTHS) get zipped. */
function firstLooseMonthKey(now = new Date()) {
  return shiftMonthKey(monthKey(now), -KEEP_LOOSE_MONTHS);
}

/** Oldest month key still kept (inclusive). Older than this is deleted. */
function oldestKeepMonthKey(now = new Date()) {
  return shiftMonthKey(monthKey(now), -(RETENTION_MONTHS - 1));
}

function parseLogDate(filename) {
  const match = filename.match(
    /^(?:output|table)-(\d{4}-\d{2}-\d{2})_(?:success|error)\.log$/
  );
  if (!match) return null;
  const d = new Date(`${match[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function statusSuffix() {
  return runFailed ? "error" : "success";
}

function dailyPath(kind) {
  return path.join(LOG_DIR, `${kind}-${dateStamp()}_${statusSuffix()}.log`);
}

function log(content) {
  outputBuffer.push(String(content));
}

function logTable(tableString) {
  tableBuffer.push(String(tableString));
}

function markError() {
  runFailed = true;
}

function hasFailed() {
  return runFailed;
}

function flushBuffers() {
  ensureLogDir();
  const stamp = new Date().toISOString();
  const header = `=== RUN ${stamp} (${statusSuffix().toUpperCase()}) ===`;

  if (outputBuffer.length > 0) {
    const body = [header, ...outputBuffer, ""].join("\n");
    fs.appendFileSync(dailyPath("output"), body + "\n", "utf8");
  }

  if (tableBuffer.length > 0) {
    const body = [header, ...tableBuffer, ""].join("\n");
    fs.appendFileSync(dailyPath("table"), body + "\n", "utf8");
  }

  outputBuffer = [];
  tableBuffer = [];
}

function crc32(buf) {
  if (typeof zlib.crc32 === "function") {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function zipFiles(filePaths, zipPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const filePath of filePaths) {
    const name = path.basename(filePath);
    const data = fs.readFileSync(filePath);
    const compressed = zlib.deflateRawSync(data);
    const checksum = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(checksum),
      u32(compressed.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      compressed,
    ]);

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(checksum),
      u32(compressed.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(filePaths.length),
    u16(filePaths.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);

  fs.writeFileSync(zipPath, Buffer.concat([...locals, centralDir, end]));
}

function maintainLogs() {
  ensureLogDir();
  const now = new Date();
  const looseFrom = firstLooseMonthKey(now); // e.g. Nov → keep Oct+Nov; zip Sep and older
  const keepFrom = oldestKeepMonthKey(now); // e.g. Nov → keep Jun..Nov; drop May and older

  /** @type {Map<string, string[]>} */
  const byMonth = new Map();

  for (const name of fs.readdirSync(LOG_DIR)) {
    const fullPath = path.join(LOG_DIR, name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const monthlyMatch = name.match(/^logs-(\d{4}-\d{2})\.zip$/);
    if (monthlyMatch) {
      if (monthlyMatch[1] < keepFrom) {
        fs.unlinkSync(fullPath);
      }
      continue;
    }

    if (!name.endsWith(".log") && !name.endsWith(".zip")) continue;

    const logDate = parseLogDate(name);
    const key = logDate ? monthKey(logDate) : monthKey(stat.mtime);

    if (key < keepFrom) {
      fs.unlinkSync(fullPath);
      continue;
    }

    // Daily logs from months before the loose window → monthly zip
    if (!logDate || key >= looseFrom) continue;

    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(fullPath);
  }

  for (const [key, files] of byMonth) {
    if (files.length === 0) continue;
    const zipPath = path.join(LOG_DIR, `logs-${key}.zip`);
    try {
      const toPack = [...files];
      if (fs.existsSync(zipPath)) {
        const prev = path.join(LOG_DIR, `.logs-${key}.prev.zip`);
        fs.renameSync(zipPath, prev);
        toPack.push(prev);
      }
      zipFiles(toPack, zipPath);
      for (const f of toPack) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.error(`Failed to zip month ${key}:`, err.message);
    }
  }
}

function finalize() {
  if (finalized) return;
  finalized = true;
  flushBuffers();
  maintainLogs();
}

module.exports = {
  LOG_DIR,
  KEEP_LOOSE_MONTHS,
  RETENTION_MONTHS,
  log,
  logTable,
  markError,
  hasFailed,
  finalize,
  maintainLogs,
};
