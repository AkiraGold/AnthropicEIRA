const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const LOG_DIR = path.resolve(__dirname, "logs");
const ZIP_AFTER_DAYS = 30;
const RETENTION_DAYS = 90; // ~1/4 year

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

function daysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function parseLogDate(filename) {
  const match = filename.match(
    /^(?:output|table)-(\d{4}-\d{2}-\d{2})_(?:success|error)\.log(?:\.zip)?$/
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

/** Create a single-entry .zip (deflate) next to the log, then delete the .log */
function zipFile(filePath) {
  const zipPath = `${filePath}.zip`;
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(filePath);
    return zipPath;
  }

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
    u32(0),
    nameBuf,
  ]);

  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);

  fs.writeFileSync(zipPath, Buffer.concat([local, central, end]));
  fs.unlinkSync(filePath);
  return zipPath;
}

function maintainLogs() {
  ensureLogDir();
  const zipBefore = daysAgo(ZIP_AFTER_DAYS);
  const deleteBefore = daysAgo(RETENTION_DAYS);

  for (const name of fs.readdirSync(LOG_DIR)) {
    const fullPath = path.join(LOG_DIR, name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const dailyDate = parseLogDate(name);
    const legacy = /^(?:output|table)-\d+\.log(?:\.zip)?$/.test(name);
    if (!dailyDate && !legacy && !name.endsWith(".log") && !name.endsWith(".zip")) {
      continue;
    }

    const ageDate = dailyDate || stat.mtime;

    if (ageDate < deleteBefore) {
      fs.unlinkSync(fullPath);
      continue;
    }

    if (name.endsWith(".log") && ageDate < zipBefore) {
      try {
        zipFile(fullPath);
      } catch (err) {
        console.error(`Failed to zip ${name}:`, err.message);
      }
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
  ZIP_AFTER_DAYS,
  RETENTION_DAYS,
  log,
  logTable,
  markError,
  hasFailed,
  finalize,
  maintainLogs,
};
