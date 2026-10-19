// Резервные копии: всё в одном .tar (library.db + uploads/*). Только встроенные модули Node.js.
//
//  • writeBackup()     — потоком отдаёт tar: снимок базы (VACUUM INTO) и все файлы из uploads/
//  • receiveRestore()  — принимает tar, раскладывает во временную папку restore-pending/ и проверяет
//  • applyPendingRestore() — вызывается при СТАРТЕ сервера, до открытия базы: подменяет данные
//  • startAutoBackup() — раз в сутки копия базы в backups/ (хранится 7 штук)
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

const BLOCK = 512;
const SQLITE_MAGIC = 'SQLite format 3\0';

/* ---------- tar: запись ---------- */
function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function tarHeader(name, size, mtimeSec) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(octal(size, 12), 124);
  h.write(octal(Math.floor(mtimeSec), 12), 136);
  h.write('        ', 148); // на время подсчёта контрольной суммы — пробелы
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

const pad = (size) => (BLOCK - (size % BLOCK)) % BLOCK;

/** Отдаёт резервную копию в res. db — DatabaseSync, чтобы сделать цельный снимок базы. */
export async function writeBackup({ db, dataDir, uploadDir, res }) {
  const snap = path.join(dataDir, `.snapshot-${process.pid}-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  try {
    const entries = [{ name: 'library.db', file: snap }];
    for (const f of fs.readdirSync(uploadDir)) {
      const full = path.join(uploadDir, f);
      if (fs.statSync(full).isFile()) entries.push({ name: `uploads/${f}`, file: full });
    }
    for (const e of entries) {
      const st = fs.statSync(e.file);
      e.size = st.size;
      e.mtime = st.mtimeMs / 1000;
      if (Buffer.byteLength(e.name) > 100) throw new Error(`Слишком длинное имя файла: ${e.name}`);
    }
    const total = entries.reduce((s, e) => s + BLOCK + e.size + pad(e.size), 0) + BLOCK * 2;
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/x-tar',
      'Content-Length': total,
      'Content-Disposition': `attachment; filename="maktabatul-backup-${stamp}.tar"`,
      'Cache-Control': 'no-store',
    });
    const send = async (buf) => { if (!res.write(buf)) await once(res, 'drain'); };
    for (const e of entries) {
      await send(tarHeader(e.name, e.size, e.mtime));
      if (e.size > 0) {
        let sent = 0;
        const rs = fs.createReadStream(e.file, { start: 0, end: e.size - 1 });
        for await (const chunk of rs) { sent += chunk.length; await send(chunk); }
        if (sent !== e.size) throw new Error(`Файл изменился во время копирования: ${e.name}`);
      }
      if (pad(e.size)) await send(Buffer.alloc(pad(e.size)));
    }
    res.end(Buffer.alloc(BLOCK * 2));
  } catch (err) {
    res.destroy(err); // клиент увидит оборванную загрузку и не примет неполный файл за копию
    throw err;
  } finally {
    fs.rmSync(snap, { force: true });
  }
}

/* ---------- tar: чтение ---------- */
function parseOctal(buf) {
  const s = buf.toString('ascii').replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function safeName(name) {
  if (name === 'library.db') return 'library.db';
  const m = /^uploads\/([^/\\]{1,100})$/.exec(name);
  if (m && m[1] !== '.' && m[1] !== '..' && !m[1].includes('\0')) return `uploads/${m[1]}`;
  return null;
}

/** Принимает tar из потока req, раскладывает в dataDir/restore-pending/. Бросает Error с понятным текстом. */
export async function receiveRestore({ req, dataDir }) {
  const stage = path.join(dataDir, 'restore-pending');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'uploads'), { recursive: true });
  const fail = (msg) => { fs.rmSync(stage, { recursive: true, force: true }); throw new Error(msg); };

  let buf = Buffer.alloc(0);
  let cur = null; // { ws, left, padLeft, name }
  let ended = false;
  let sawDb = false;
  let files = 0;

  const closeCur = async () => {
    if (!cur?.ws) return;
    cur.ws.end();
    await once(cur.ws, 'finish');
  };

  try {
    for await (const chunk of req) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (ended) { buf = Buffer.alloc(0); break; }
        if (cur && cur.left > 0) {
          const take = Math.min(cur.left, buf.length);
          if (!take) break;
          if (cur.ws && !cur.ws.write(buf.subarray(0, take))) await once(cur.ws, 'drain');
          cur.left -= take;
          buf = buf.subarray(take);
          if (cur.left > 0) break;
          await closeCur();
        }
        if (cur && cur.padLeft > 0) {
          const skip = Math.min(cur.padLeft, buf.length);
          cur.padLeft -= skip;
          buf = buf.subarray(skip);
          if (cur.padLeft > 0) break;
        }
        if (cur && cur.left === 0 && cur.padLeft === 0) cur = null;
        if (buf.length < BLOCK) break;
        const h = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (h.every((b) => b === 0)) { ended = true; continue; }
        const stored = parseOctal(h.subarray(148, 156));
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
        if (sum !== stored) fail('Это не файл резервной копии (повреждён заголовок архива).');
        const type = String.fromCharCode(h[156] || 48);
        const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        const size = parseOctal(h.subarray(124, 136));
        if (type === '5') continue; // каталог — пропускаем
        if (type !== '0') fail('Неподдерживаемый формат архива. Нужна копия, скачанная из этой же админки.');
        const safe = safeName(name);
        if (!safe) fail(`Недопустимое имя в архиве: ${name.slice(0, 60)}`);
        const ws = fs.createWriteStream(path.join(stage, safe));
        ws.on('error', () => {});
        cur = { ws, left: size, padLeft: pad(size), name: safe };
        if (safe === 'library.db') sawDb = true;
        files++;
        if (size === 0) { await closeCur(); cur = null; }
      }
    }
    if (cur && (cur.left > 0)) fail('Файл копии загружен не полностью — повторите.');
  } catch (e) {
    if (cur?.ws) cur.ws.destroy();
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  if (!ended || !sawDb) fail('В архиве нет базы данных или он оборван — это не полная резервная копия.');
  const head = Buffer.alloc(16);
  const fd = fs.openSync(path.join(stage, 'library.db'), 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== SQLITE_MAGIC) fail('library.db в архиве не похожа на базу данных.');
  fs.writeFileSync(path.join(stage, '.ready'), String(Date.now()));
  return { files };
}

/** При старте, ДО открытия базы: если есть подготовленное восстановление — подменяем данные. */
export function applyPendingRestore(dataDir) {
  const stage = path.join(dataDir, 'restore-pending');
  if (!fs.existsSync(path.join(stage, '.ready'))) {
    fs.rmSync(stage, { recursive: true, force: true }); // недокачанное — выбрасываем
    return false;
  }
  const old = path.join(dataDir, 'before-restore');
  fs.rmSync(old, { recursive: true, force: true });
  fs.mkdirSync(old, { recursive: true });
  for (const f of ['library.db', 'library.db-wal', 'library.db-shm']) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.renameSync(p, path.join(old, f));
  }
  const up = path.join(dataDir, 'uploads');
  if (fs.existsSync(up)) fs.renameSync(up, path.join(old, 'uploads'));
  fs.renameSync(path.join(stage, 'library.db'), path.join(dataDir, 'library.db'));
  fs.renameSync(path.join(stage, 'uploads'), up);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log('Данные восстановлены из резервной копии (прежние лежат в before-restore/).');
  return true;
}

/* ---------- Ежедневная копия базы ---------- */
export function startAutoBackup({ db, dataDir, keep = 7 }) {
  const dir = path.join(dataDir, 'backups');
  const run = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `library-${new Date().toISOString().slice(0, 10)}.db`);
      if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const all = fs.readdirSync(dir).filter((f) => /^library-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
      for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
    } catch (e) {
      console.error('Автокопия базы не удалась:', e.message);
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 3600_000).unref(); // проверяем каждые 6 часов; копия за день создаётся один раз
}
