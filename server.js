// Сервер библиотеки. Только встроенные модули Node.js (>= 22.13), npm install не нужен.
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { writeBackup, receiveRestore, applyPendingRestore, startAutoBackup } from './backup.js';
import { movedConfig, movedOverlayHtml } from './moved.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Настройки (переменные окружения) ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PDF_MB = Number(process.env.MAX_PDF_MB || 200);
const ADMIN_NICK = (process.env.ADMIN_NICK || '').trim().toLowerCase();
const REGISTRATION_OPEN = (process.env.REGISTRATION || 'open') !== 'closed';
const MOVED = movedConfig(process.env); // MOVED_TO задан — поверх сайта показываем окно «Сайт переехал»
const SESSION_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
applyPendingRestore(DATA_DIR); // если в админке загружали резервную копию — подменяем данные до открытия базы
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- База данных ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    translator TEXT NOT NULL DEFAULT '',
    publisher TEXT NOT NULL DEFAULT '',
    section TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'ru',
    description TEXT NOT NULL DEFAULT '',
    pages INTEGER NOT NULL DEFAULT 0,
    pdf_file TEXT NOT NULL,
    cover_file TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS annotations (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );
`);

// серия чтения («огонёк»): добавляем колонки в уже существующую базу
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('streak')) db.exec('ALTER TABLE users ADD COLUMN streak INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('best_streak')) db.exec('ALTER TABLE users ADD COLUMN best_streak INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('last_read_day')) db.exec("ALTER TABLE users ADD COLUMN last_read_day TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('last_seen_at')) db.exec('ALTER TABLE users ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
  // профиль: номер телефона и версия аватарки (0 — аватарки нет; меняется при каждой загрузке, чтобы браузер не держал старую)
  if (!cols.includes('phone')) db.exec("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('avatar_ver')) db.exec('ALTER TABLE users ADD COLUMN avatar_ver INTEGER NOT NULL DEFAULT 0');
  // «читает прямо сейчас»: книга и время последнего сигнала от открытой читалки
  if (!cols.includes('now_book_id')) db.exec('ALTER TABLE users ADD COLUMN now_book_id INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('now_at')) db.exec('ALTER TABLE users ADD COLUMN now_at INTEGER NOT NULL DEFAULT 0');
  // устройства: у каждой сессии запоминаем, с чего вошли и когда им пользовались
  const sCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!sCols.includes('ua')) db.exec("ALTER TABLE sessions ADD COLUMN ua TEXT NOT NULL DEFAULT ''");
  if (!sCols.includes('created_at')) db.exec('ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
  if (!sCols.includes('last_used_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0');
}

// статистика чтения: какие страницы человек прочитал в какой день (день — по часам его устройства).
// Страница в один день считается один раз, сколько бы раз её ни перелистывали.
db.exec(`
  CREATE TABLE IF NOT EXISTS read_pages (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    book_id INTEGER NOT NULL,
    page INTEGER NOT NULL,
    PRIMARY KEY (user_id, day, book_id, page)
  ) WITHOUT ROWID;
`);

const now = () => Date.now();
const LANGS = ['ru', 'ar', 'en'];
const cleanSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
cleanSessions();
setInterval(cleanSessions, 3600000).unref();
db.exec('CREATE INDEX IF NOT EXISTS idx_books_created ON books(created_at DESC, id DESC)');

// ---------- Вспомогательное ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Сжатие ответов (brotli / gzip) ----------
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.txt', '.webmanifest']);
const encCache = new Map(); // файл+версия+кодировка -> Promise<Buffer>

function pickEncoding(req) {
  const a = String(req?.headers?.['accept-encoding'] || '');
  if (/\bbr\b/.test(a)) return 'br';
  if (/\bgzip\b/.test(a)) return 'gzip';
  return null;
}

function compressAsync(buf, enc) {
  return new Promise((resolve, reject) => {
    const cb = (e, out) => (e ? reject(e) : resolve(out));
    if (enc === 'br') {
      zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }, cb);
    } else {
      zlib.gzip(buf, { level: 9 }, cb);
    }
  });
}

function sendJson(res, status, obj, headers = {}) {
  let body = Buffer.from(JSON.stringify(obj));
  const extra = {};
  const enc = body.length > 1024 ? pickEncoding(res.req) : null;
  if (enc) {
    body = enc === 'br'
      ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
      : zlib.gzipSync(body, { level: 6 });
    extra['Content-Encoding'] = enc;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    ...extra,
    ...headers,
  });
  res.end(body);
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '';
}

function isSecure(req) {
  return !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* битая кука — игнорируем */
    }
  }
  return out;
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- Пароли и сессии ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionCookie(req, token, maxAgeSec) {
  const parts = [`sid=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function createSession(req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const t = now();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, ua, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    token, userId, t + SESSION_DAYS * 86400000, String(req.headers['user-agent'] || '').slice(0, 300), t, t
  );
  return sessionCookie(req, token, SESSION_DAYS * 86400);
}

// Человеческое название устройства по User-Agent: «iPhone · Safari», «Windows · Chrome»
function deviceLabel(ua) {
  ua = String(ua || '');
  if (!ua) return 'Неизвестное устройство';
  let os = '';
  if (/iPad/.test(ua)) os = 'iPad';
  else if (/iPhone|iPod/.test(ua)) os = 'iPhone';
  else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? 'Android-телефон' : 'Android-планшет';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = '';
  if (/YaBrowser/.test(ua)) br = 'Яндекс Браузер';
  else if (/Edg(e|A|iOS)?\//.test(ua)) br = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) br = 'Opera';
  else if (/SamsungBrowser/.test(ua)) br = 'Samsung Internet';
  else if (/Firefox|FxiOS/.test(ua)) br = 'Firefox';
  else if (/Chrome|CriOS/.test(ua)) br = 'Chrome';
  else if (/Safari/.test(ua)) br = 'Safari';
  return [os, br].filter(Boolean).join(' · ') || 'Неизвестное устройство';
}

// время последнего использования устройства (сессии) — не чаще раза в минуту
const sessSeen = new Map();
function touchSession(token) {
  if (!token) return;
  const t = now();
  if (t - (sessSeen.get(token) || 0) < 60000) return;
  sessSeen.set(token, t);
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(t, token);
}
setInterval(() => { if (sessSeen.size > 5000) sessSeen.clear(); }, 3600000).unref();

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.nick, u.is_admin, u.phone, u.avatar_ver, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, nick: row.nick, isAdmin: !!row.is_admin, phone: row.phone || '', avatarVer: row.avatar_ver || 0, token };
}

// «Был в сети»: любой запрос вошедшего пользователя к API обновляет время, но не чаще раза в минуту
const seenAt = new Map();
function touchSeen(user) {
  if (!user) return;
  const t = now();
  if (t - (seenAt.get(user.id) || 0) < 60000) return;
  seenAt.set(user.id, t);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(t, user.id);
}

const attempts = new Map();
function tooManyAttempts(ip) {
  const t = now();
  const rec = attempts.get(ip);
  if (!rec || rec.reset < t) {
    attempts.set(ip, { count: 1, reset: t + 10 * 60000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 20;
}
setInterval(() => {
  const t = now();
  for (const [k, v] of attempts) if (v.reset < t) attempts.delete(k);
}, 600000).unref();

const requireUser = (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'Нужно войти в аккаунт');
};
const requireAdmin = (ctx) => {
  requireUser(ctx);
  if (!ctx.user.isAdmin) throw new HttpError(403, 'Только для администратора');
};

// ---------- Раздача файлов (Range, ETag) ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

function sendFile(req, res, file, { type, cache = 'public, max-age=3600', headers = {} } = {}) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: 'Не найдено' });
  }
  if (!st.isFile()) return sendJson(res, 404, { error: 'Не найдено' });

  const ext = path.extname(file).toLowerCase();
  const enc = !req.headers.range && !type && COMPRESSIBLE.has(ext) && st.size > 1024 ? pickEncoding(req) : null;
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${enc ? '-' + enc : ''}"`;
  const base = {
    'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    ...(COMPRESSIBLE.has(ext) ? { Vary: 'Accept-Encoding' } : {}),
    ...headers,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, base);
    return res.end();
  }
  if (enc) {
    const key = `${file}|${st.size}|${st.mtimeMs}|${enc}`;
    let job = encCache.get(key);
    if (!job) {
      job = fs.promises.readFile(file).then((buf) => compressAsync(buf, enc));
      encCache.set(key, job);
      job.catch(() => encCache.delete(key));
    }
    job.then(
      (buf) => {
        res.writeHead(200, { ...base, 'Content-Encoding': enc, 'Content-Length': buf.length });
        res.end(req.method === 'HEAD' ? undefined : buf);
      },
      () => sendJson(res, 500, { error: 'Ошибка чтения файла' })
    );
    return;
  }

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    if (m[1] === '') {
      start = Math.max(0, st.size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    base['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  base['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, base);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Некорректный путь' });
  }
  if (rel.includes('\0')) return sendJson(res, 400, { error: 'Некорректный путь' });
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Нет доступа' });
  }
  const longCache = file.startsWith(path.join(PUBLIC_DIR, 'vendor') + path.sep);
  // свой интерфейс (html/js/css) всегда сверяем по ETag — правки видны сразу; pdf.js кэшируем на месяц
  sendFile(req, res, file, { cache: longCache ? 'public, max-age=2592000' : 'no-cache' });
}

// ---------- Потоковый разбор multipart/form-data ----------
const FILE_FIELDS = new Set(['pdf', 'cover']);
const rid = () => crypto.randomBytes(8).toString('hex');

function removeFile(name) {
  if (!name) return;
  fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(name))).catch(() => {});
}

function readMultipart(req, { maxFileBytes }) {
  return new Promise((resolve, reject) => {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '') || !m) {
      return reject(new HttpError(400, 'Ожидалась форма multipart/form-data'));
    }
    const delim = Buffer.from('\r\n--' + (m[1] || m[2]).trim());
    const fields = {};
    const files = {};
    const created = []; // { name, ws }
    const finished = [];
    let buf = Buffer.from('\r\n'); // «подушка», чтобы первая граница тоже начиналась с CRLF
    let state = 'body'; // body | after | headers | done
    let sink = null;
    let failed = false;
    let drainWs = null;

    const fail = (err) => {
      if (failed) return;
      failed = true;
      for (const c of created) {
        c.ws.destroy();
        removeFile(c.name);
      }
      req.resume();
      reject(err);
    };

    const startPart = (rawHeaders) => {
      const headers = {};
      for (const line of rawHeaders.split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const cd = headers['content-disposition'] || '';
      const name = /\bname="([^"]*)"/i.exec(cd)?.[1];
      const fileM = /\bfilename="([^"]*)"/i.exec(cd);
      if (name === undefined) {
        sink = null;
        return;
      }
      if (fileM) {
        if (!fileM[1] || !FILE_FIELDS.has(name) || files[name]) {
          sink = null; // пустое поле файла или лишний файл — пропускаем
          return;
        }
        let ext = name === 'pdf' ? '.pdf' : path.extname(fileM[1]).toLowerCase();
        if (name === 'cover' && !['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) ext = '.jpg';
        const stored = `${Date.now()}-${rid()}${ext}`;
        const ws = fs.createWriteStream(path.join(UPLOAD_DIR, stored));
        ws.on('error', (e) => fail(e));
        created.push({ name: stored, ws });
        sink = { kind: 'file', field: name, ws, size: 0, stored, original: fileM[1] };
      } else {
        sink = { kind: 'field', field: name, chunks: [], size: 0 };
      }
    };

    const emit = (data) => {
      if (!sink || !data.length) return;
      sink.size += data.length;
      if (sink.kind === 'field') {
        if (sink.size > 1024 * 1024) return fail(new HttpError(413, 'Слишком длинное текстовое поле'));
        sink.chunks.push(Buffer.from(data));
      } else {
        if (sink.size > maxFileBytes) {
          return fail(new HttpError(413, `Файл больше ${Math.round(maxFileBytes / 1048576)} МБ`));
        }
        if (!sink.ws.write(data)) drainWs = sink.ws;
      }
    };

    const endPart = () => {
      if (!sink) return;
      if (sink.kind === 'field') {
        fields[sink.field] = Buffer.concat(sink.chunks).toString('utf8');
      } else {
        const s = sink;
        finished.push(new Promise((res2) => s.ws.once('finish', res2)));
        s.ws.end();
        files[s.field] = { filename: s.stored, originalName: s.original, size: s.size };
      }
      sink = null;
    };

    req.on('data', (chunk) => {
      if (failed) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (failed) return;
        if (state === 'body') {
          const idx = buf.indexOf(delim);
          if (idx === -1) {
            const keep = delim.length - 1;
            if (buf.length > keep) {
              emit(buf.subarray(0, buf.length - keep));
              buf = buf.subarray(buf.length - keep);
            }
            break;
          }
          emit(buf.subarray(0, idx));
          if (failed) return;
          endPart();
          buf = buf.subarray(idx + delim.length);
          state = 'after';
        } else if (state === 'after') {
          if (buf.length < 2) break;
          if (buf[0] === 0x2d && buf[1] === 0x2d) {
            state = 'done';
            buf = Buffer.alloc(0);
            break;
          }
          if (buf[0] === 0x0d && buf[1] === 0x0a) {
            buf = buf.subarray(2);
            state = 'headers';
          } else {
            return fail(new HttpError(400, 'Повреждённая форма'));
          }
        } else if (state === 'headers') {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) {
            if (buf.length > 16384) return fail(new HttpError(400, 'Повреждённая форма'));
            break;
          }
          startPart(buf.subarray(0, idx).toString('utf8'));
          buf = buf.subarray(idx + 4);
          state = 'body';
        } else {
          buf = Buffer.alloc(0);
          break;
        }
      }
      if (drainWs) {
        const w = drainWs;
        drainWs = null;
        if (!w.writableEnded && !w.destroyed) {
          req.pause();
          w.once('drain', () => req.resume());
        }
      }
    });

    req.on('end', () => {
      if (failed) return;
      if (state !== 'done') return fail(new HttpError(400, 'Запрос оборван'));
      Promise.all(finished).then(() => resolve({ fields, files }));
    });
    req.on('error', (e) => fail(e));
    req.on('aborted', () => fail(new HttpError(400, 'Загрузка прервана')));
  });
}

function readHead(file, n) {
  const fd = fs.openSync(path.join(UPLOAD_DIR, file.filename), 'r');
  try {
    const b = Buffer.alloc(n);
    const got = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function isPdf(file) {
  try {
    return readHead(file, 1024).includes('%PDF-');
  } catch {
    return false;
  }
}

function isImage(file) {
  try {
    const b = readHead(file, 12);
    const jpeg = b[0] === 0xff && b[1] === 0xd8;
    const png = b.toString('latin1', 1, 4) === 'PNG';
    const webp = b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    return jpeg || png || webp;
  } catch {
    return false;
  }
}

function cleanupUploaded(files) {
  for (const f of Object.values(files || {})) removeFile(f.filename);
}

function readFields(body) {
  const s = (v, max) => String(v ?? '').trim().slice(0, max);
  return {
    title: s(body.title, 300),
    author: s(body.author, 200),
    translator: s(body.translator, 200),
    publisher: s(body.publisher, 200),
    section: s(body.section, 100),
    language: LANGS.includes(body.language) ? body.language : 'ru',
    description: s(body.description, 5000),
    pages: Math.max(0, Math.min(100000, parseInt(body.pages, 10) || 0)),
  };
}

async function receiveBookForm(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > (MAX_PDF_MB + 20) * 1048576) {
    throw new HttpError(413, `Файл больше ${MAX_PDF_MB} МБ`);
  }
  return readMultipart(req, { maxFileBytes: MAX_PDF_MB * 1048576 });
}

// ---------- Книги: представление ----------
function getBook(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(Number(id));
}

// избранное и прогресс пользователя одним проходом, а не по запросу на каждую книгу
function userMaps(userId) {
  if (!userId) return null;
  return {
    fav: new Set(db.prepare('SELECT book_id FROM favorites WHERE user_id = ?').all(userId).map((r) => r.book_id)),
    prog: new Map(db.prepare('SELECT book_id, page, updated_at FROM progress WHERE user_id = ?').all(userId).map((r) => [r.book_id, r])),
  };
}

function bookToJson(b, userId, maps) {
  const out = {
    id: b.id,
    title: b.title,
    author: b.author,
    translator: b.translator,
    publisher: b.publisher,
    section: b.section,
    language: b.language,
    description: b.description,
    pages: b.pages,
    hasCover: !!b.cover_file,
    version: b.updated_at,
    createdAt: b.created_at,
  };
  if (userId) {
    const m = maps || userMaps(userId);
    out.favorite = m.fav.has(b.id);
    const p = m.prog.get(b.id);
    out.progress = p ? { page: p.page, updatedAt: p.updated_at } : null;
  }
  return out;
}

const norm = (s) => String(s || '').toLocaleLowerCase('ru');

// ---------- Маршруты ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:([a-z]+)/gi, (_m, k) => (keys.push(k), '([^/]+)')) + '/?$'
  );
  routes.push({ method, re, keys, handler });
}

// --- Аккаунты
const NICK_RE = /^[a-zA-Z0-9_]{3,24}$/;

route('POST', '/api/register', async (ctx) => {
  if (!REGISTRATION_OPEN) throw new HttpError(403, 'Регистрация закрыта');
  if (tooManyAttempts(ctx.ip)) throw new HttpError(429, 'Слишком много попыток, попробуйте позже');
  const body = await readJson(ctx.req);
  const nick = String(body.nick || '').trim();
  const password = String(body.password || '');
  if (!NICK_RE.test(nick)) throw new HttpError(400, 'Ник: 3–24 символа, только латиница, цифры и «_»');
  if (password.length < 6 || password.length > 200) throw new HttpError(400, 'Пароль должен быть не короче 6 символов');
  if (db.prepare('SELECT 1 FROM users WHERE nick = ?').get(nick)) throw new HttpError(409, 'Такой ник уже занят');
  const isFirst = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
  const isAdmin = isFirst || (ADMIN_NICK && nick.toLowerCase() === ADMIN_NICK) ? 1 : 0;
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare('INSERT INTO users (nick, pass_hash, salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(nick, hashPassword(password, salt), salt, isAdmin, now());
  const id = Number(info.lastInsertRowid);
  touchSeen({ id });
  sendJson(ctx.res, 200, { user: { id, nick, isAdmin: !!isAdmin, phone: '', avatarVer: 0 } }, { 'Set-Cookie': createSession(ctx.req, id) });
});

route('POST', '/api/login', async (ctx) => {
  if (tooManyAttempts(ctx.ip)) throw new HttpError(429, 'Слишком много попыток, попробуйте позже');
  const body = await readJson(ctx.req);
  const nick = String(body.nick || '').trim();
  const password = String(body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE nick = ?').get(nick);
  if (!u || !verifyPassword(password, u.salt, u.pass_hash)) throw new HttpError(401, 'Неверный ник или пароль');
  if (ADMIN_NICK && u.nick.toLowerCase() === ADMIN_NICK && !u.is_admin) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
    u.is_admin = 1;
  }
  touchSeen({ id: u.id });
  sendJson(
    ctx.res, 200,
    { user: { id: u.id, nick: u.nick, isAdmin: !!u.is_admin, phone: u.phone || '', avatarVer: u.avatar_ver || 0 } },
    { 'Set-Cookie': createSession(ctx.req, u.id) }
  );
});

route('POST', '/api/logout', (ctx) => {
  if (ctx.user) db.prepare('DELETE FROM sessions WHERE token = ?').run(ctx.user.token);
  sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(ctx.req, '', 0) });
});

route('GET', '/api/me', (ctx) => {
  const registration = REGISTRATION_OPEN;
  if (!ctx.user) return sendJson(ctx.res, 200, { user: null, registration });
  const { id, nick, isAdmin, phone, avatarVer } = ctx.user;
  sendJson(ctx.res, 200, { user: { id, nick, isAdmin, phone, avatarVer }, registration });
});

route('POST', '/api/password', async (ctx) => {
  requireUser(ctx);
  const body = await readJson(ctx.req);
  const oldPass = String(body.oldPassword || '');
  const newPass = String(body.newPassword || '');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  if (!verifyPassword(oldPass, u.salt, u.pass_hash)) throw new HttpError(400, 'Текущий пароль указан неверно');
  if (newPass.length < 6 || newPass.length > 200) throw new HttpError(400, 'Новый пароль должен быть не короче 6 символов');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hashPassword(newPass, salt), salt, u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, ctx.user.token); // другие устройства — выйти
  sendJson(ctx.res, 200, { ok: true });
});

// --- Профиль: номер телефона и аватарка
const AVATAR_MAX = 1024 * 1024;
const avatarFile = (id) => path.join(UPLOAD_DIR, `avatar-${Number(id)}.jpg`); // файлы лежат прямо в uploads/, чтобы попадать в резервную копию

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!chunks.length) return; // уже отказали
        chunks.length = 0;
        reject(new HttpError(413, 'Файл слишком большой'));
        return; // остаток просто сбрасываем, чтобы ответ с ошибкой дошёл до браузера
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

route('PUT', '/api/profile', async (ctx) => {
  requireUser(ctx);
  const body = await readJson(ctx.req);
  const raw = String(body.phone ?? '').trim();
  const phone = raw.replace(/[\s().-]/g, '');
  if (phone && !/^\+?\d{10,15}$/.test(phone)) {
    throw new HttpError(400, 'Номер телефона: от 10 до 15 цифр, можно с «+» в начале');
  }
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, ctx.user.id);
  sendJson(ctx.res, 200, { phone });
});

route('PUT', '/api/avatar', async (ctx) => {
  requireUser(ctx);
  const buf = await readBody(ctx.req, AVATAR_MAX);
  // принимаем только настоящий JPEG (браузер сам сжимает фото до квадрата перед отправкой)
  if (buf.length < 100 || !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    throw new HttpError(400, 'Нужна картинка в формате JPEG');
  }
  const file = avatarFile(ctx.user.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  const ver = now();
  db.prepare('UPDATE users SET avatar_ver = ? WHERE id = ?').run(ver, ctx.user.id);
  sendJson(ctx.res, 200, { avatarVer: ver });
});

route('DELETE', '/api/avatar', (ctx) => {
  requireUser(ctx);
  try { fs.unlinkSync(avatarFile(ctx.user.id)); } catch { /* файла уже нет */ }
  db.prepare('UPDATE users SET avatar_ver = 0 WHERE id = ?').run(ctx.user.id);
  sendJson(ctx.res, 200, { avatarVer: 0 });
});

// аватарку видят только сам человек и администратор
route('GET', '/api/avatar/:id', (ctx) => {
  requireUser(ctx);
  const id = Number(ctx.params.id);
  if (id !== ctx.user.id && !ctx.user.isAdmin) throw new HttpError(403, 'Нет доступа');
  sendFile(ctx.req, ctx.res, avatarFile(id), { type: 'image/jpeg', cache: 'private, max-age=31536000, immutable' }); // адрес меняется вместе с ?v=
});

// --- Книги: чтение
route('GET', '/api/books', (ctx) => {
  const q = norm(ctx.query.get('q')).trim();
  const section = String(ctx.query.get('section') || '').trim();
  const lang = String(ctx.query.get('lang') || '').trim();
  const publisher = norm(ctx.query.get('publisher')).trim();
  let rows = db.prepare('SELECT * FROM books ORDER BY created_at DESC, id DESC').all();
  if (section) rows = rows.filter((b) => b.section === section);
  if (lang) rows = rows.filter((b) => b.language === lang);
  if (publisher) rows = rows.filter((b) => norm(b.publisher).trim() === publisher);
  if (q) {
    // SQLite LIKE не понимает регистр кириллицы и арабицы, поэтому ищем в JS
    const words = q.split(/\s+/).filter(Boolean);
    rows = rows.filter((b) => {
      const hay = norm([b.title, b.author, b.translator, b.publisher, b.section, b.description].join(' '));
      return words.every((w) => hay.includes(w));
    });
  }
  const maps = userMaps(ctx.user?.id);
  sendJson(ctx.res, 200, { books: rows.map((b) => bookToJson(b, ctx.user?.id, maps)) });
});

route('GET', '/api/sections', (ctx) => {
  const rows = db
    .prepare('SELECT section, COUNT(*) AS count FROM books GROUP BY section ORDER BY section COLLATE NOCASE')
    .all();
  sendJson(ctx.res, 200, { sections: rows.map((r) => ({ name: r.section, count: r.count })) });
});

// Издательства: уникальные названия (без учёта регистра) и число книг у каждого
route('GET', '/api/publishers', (ctx) => {
  const rows = db.prepare('SELECT publisher FROM books ORDER BY created_at DESC, id DESC').all();
  const map = new Map();
  for (const r of rows) {
    const name = String(r.publisher || '').trim();
    if (!name) continue;
    const key = norm(name);
    const cur = map.get(key) || { name, count: 0 };
    cur.count += 1;
    map.set(key, cur);
  }
  const publishers = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  sendJson(ctx.res, 200, { publishers });
});

route('GET', '/api/books/:id', (ctx) => {
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  sendJson(ctx.res, 200, { book: bookToJson(b, ctx.user?.id) });
});

route('GET', '/api/books/:id/pdf', (ctx) => {
  requireUser(ctx);
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  sendFile(ctx.req, ctx.res, path.join(UPLOAD_DIR, path.basename(b.pdf_file)), {
    type: 'application/pdf',
    cache: 'private, max-age=3600',
    headers: { 'Content-Disposition': 'inline' },
  });
});

route('GET', '/api/books/:id/cover', (ctx) => {
  const b = getBook(ctx.params.id);
  if (!b || !b.cover_file) throw new HttpError(404, 'Нет обложки');
  sendFile(ctx.req, ctx.res, path.join(UPLOAD_DIR, path.basename(b.cover_file)), {
    cache: 'public, max-age=86400',
  });
});

// --- Книги: управление
route('POST', '/api/books', async (ctx) => {
  requireAdmin(ctx);
  const { fields, files } = await receiveBookForm(ctx.req);
  try {
    const f = readFields(fields);
    const { pdf, cover } = files;
    if (!pdf) throw new HttpError(400, 'Выберите PDF-файл');
    if (!f.title || !f.section) throw new HttpError(400, 'Укажите название и раздел');
    if (!isPdf(pdf)) throw new HttpError(400, 'Файл не похож на PDF');
    let coverName = null;
    if (cover) {
      if (isImage(cover)) coverName = cover.filename;
      else removeFile(cover.filename);
    }
    const t = now();
    const info = db
      .prepare(
        `INSERT INTO books (title, author, translator, publisher, section, language, description, pages,
                            pdf_file, cover_file, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.title, f.author, f.translator, f.publisher, f.section, f.language, f.description, f.pages,
        pdf.filename, coverName, t, t);
    sendJson(ctx.res, 200, { book: bookToJson(getBook(info.lastInsertRowid), ctx.user.id) });
  } catch (e) {
    cleanupUploaded(files);
    throw e;
  }
});

route('PUT', '/api/books/:id', async (ctx) => {
  requireAdmin(ctx);
  const { fields, files } = await receiveBookForm(ctx.req);
  try {
    const old = getBook(ctx.params.id);
    if (!old) throw new HttpError(404, 'Книга не найдена');
    const f = readFields(fields);
    if (!f.title || !f.section) throw new HttpError(400, 'Укажите название и раздел');
    const { pdf, cover } = files;
    let pdfFile = old.pdf_file;
    let coverFile = old.cover_file;
    let pages = f.pages || old.pages;
    if (pdf && !isPdf(pdf)) throw new HttpError(400, 'Файл не похож на PDF');
    if (pdf) {
      pdfFile = pdf.filename;
      pages = f.pages || 0;
    }
    if (cover) {
      if (isImage(cover)) coverFile = cover.filename;
      else removeFile(cover.filename);
    }
    db.prepare(
      `UPDATE books SET title=?, author=?, translator=?, publisher=?, section=?, language=?, description=?,
                        pages=?, pdf_file=?, cover_file=?, updated_at=? WHERE id=?`
    ).run(f.title, f.author, f.translator, f.publisher, f.section, f.language, f.description,
      pages, pdfFile, coverFile, now(), old.id);
    if (pdf) {
      removeFile(old.pdf_file);
      db.prepare('DELETE FROM progress WHERE book_id = ?').run(old.id); // файл заменён — страницы другие
    }
    if (cover && coverFile !== old.cover_file) removeFile(old.cover_file);
    sendJson(ctx.res, 200, { book: bookToJson(getBook(old.id), ctx.user.id) });
  } catch (e) {
    cleanupUploaded(files);
    throw e;
  }
});

route('DELETE', '/api/books/:id', (ctx) => {
  requireAdmin(ctx);
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  db.prepare('DELETE FROM books WHERE id = ?').run(b.id);
  removeFile(b.pdf_file);
  removeFile(b.cover_file);
  sendJson(ctx.res, 200, { ok: true });
});

// --- Избранное
route('GET', '/api/favorites', (ctx) => {
  requireUser(ctx);
  const rows = db
    .prepare(
      `SELECT b.* FROM favorites f JOIN books b ON b.id = f.book_id
       WHERE f.user_id = ? ORDER BY f.created_at DESC`
    )
    .all(ctx.user.id);
  const maps = userMaps(ctx.user.id);
  sendJson(ctx.res, 200, { books: rows.map((b) => bookToJson(b, ctx.user.id, maps)) });
});

route('PUT', '/api/favorites/:id', (ctx) => {
  requireUser(ctx);
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, book_id, created_at) VALUES (?, ?, ?)').run(
    ctx.user.id, b.id, now()
  );
  sendJson(ctx.res, 200, { favorite: true });
});

route('DELETE', '/api/favorites/:id', (ctx) => {
  requireUser(ctx);
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND book_id = ?').run(ctx.user.id, Number(ctx.params.id));
  sendJson(ctx.res, 200, { favorite: false });
});

// --- Прогресс чтения
route('GET', '/api/progress', (ctx) => {
  requireUser(ctx);
  const rows = db
    .prepare(
      `SELECT b.*, p.page AS p_page, p.updated_at AS p_updated FROM progress p
       JOIN books b ON b.id = p.book_id WHERE p.user_id = ? ORDER BY p.updated_at DESC`
    )
    .all(ctx.user.id);
  const maps = userMaps(ctx.user.id);
  sendJson(ctx.res, 200, {
    items: rows.map((r) => ({ page: r.p_page, updatedAt: r.p_updated, book: bookToJson(r, ctx.user.id, maps) })),
  });
});

route('PUT', '/api/progress/:id', async (ctx) => {
  requireUser(ctx);
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  const body = await readJson(ctx.req);
  let page = parseInt(body.page, 10);
  if (!Number.isFinite(page) || page < 1) throw new HttpError(400, 'Некорректная страница');
  if (b.pages > 0) page = Math.min(page, b.pages);
  db.prepare(
    `INSERT INTO progress (user_id, book_id, page, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, book_id) DO UPDATE SET page = excluded.page, updated_at = excluded.updated_at`
  ).run(ctx.user.id, b.id, page, now());
  sendJson(ctx.res, 200, { page });
});

// Сколько страниц прочитано: страница засчитывается, когда её продержали открытой ~12 секунд
// (таймер на устройстве, пока вкладка на виду). Само перелистывание чтением не считается.
// Сервер принимает не больше одной засчитанной страницы (или разворота) за READ_MIN_GAP_MS на человека.
const READ_MIN_GAP_MS = 10000;
const lastCredit = new Map(); // userId -> время последнего засчитывания
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function clientDay(s) {
  const today = Math.floor(now() / DAY_MS);
  const str = String(s || '');
  if (DAY_RE.test(str)) {
    const n = dayNum(str);
    if (Number.isFinite(n) && new Date(n * DAY_MS).toISOString().slice(0, 10) === str && Math.abs(n - today) <= 1) return str;
  }
  return new Date(today * DAY_MS).toISOString().slice(0, 10);
}
route('POST', '/api/read-pages/:id', async (ctx) => {
  requireUser(ctx);
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  const body = await readJson(ctx.req);
  const pages = [...new Set((Array.isArray(body.pages) ? body.pages : []).map((p) => parseInt(p, 10)))];
  if (!pages.length || pages.length > 2 || pages.some((p) => !Number.isFinite(p) || p < 1 || (b.pages > 0 && p > b.pages))) {
    throw new HttpError(400, 'Некорректные страницы');
  }
  const t = now();
  if (t - (lastCredit.get(ctx.user.id) || 0) < READ_MIN_GAP_MS) return sendJson(ctx.res, 200, { credited: 0 });
  lastCredit.set(ctx.user.id, t);
  const d = clientDay(body.day);
  const ins = db.prepare('INSERT OR IGNORE INTO read_pages (user_id, day, book_id, page) VALUES (?, ?, ?, ?)');
  for (const p of pages) ins.run(ctx.user.id, d, b.id, p);
  sendJson(ctx.res, 200, { credited: pages.length });
});

// Статистика по дням: сколько страниц прочитано в каждый день (за последние ~400 дней)
route('GET', '/api/read-stats', (ctx) => {
  requireUser(ctx);
  const from = new Date(now() - 400 * DAY_MS).toISOString().slice(0, 10);
  const rows = db
    .prepare('SELECT day, COUNT(*) AS c FROM read_pages WHERE user_id = ? AND day >= ? GROUP BY day')
    .all(ctx.user.id, from);
  const days = {};
  for (const r of rows) days[r.day] = r.c;
  sendJson(ctx.res, 200, { days }, { 'Cache-Control': 'no-store' });
});

// Лучшие читатели: сколько страниц прочитано за день, неделю (с понедельника) и месяц. Администраторы в рейтинге не участвуют.
// Сегодняшний день присылает устройство (как для статистики), поэтому день, неделя и месяц считаются по его календарю.
const TOP_LIMIT = 10;
route('GET', '/api/top', (ctx) => {
  requireUser(ctx);
  const day = clientDay(ctx.query.get('day'));
  const n = dayNum(day);
  const weekday = (new Date(n * DAY_MS).getUTCDay() + 6) % 7; // 0 — понедельник
  const ranges = {
    day: [day, day],
    week: [new Date((n - weekday) * DAY_MS).toISOString().slice(0, 10), day],
    month: [`${day.slice(0, 7)}-01`, day],
  };
  const q = db.prepare(
    `SELECT u.id, u.nick, u.avatar_ver, COUNT(*) AS pages
     FROM read_pages r JOIN users u ON u.id = r.user_id
     WHERE u.is_admin = 0 AND r.day >= ? AND r.day <= ?
     GROUP BY r.user_id ORDER BY pages DESC, u.nick`
  );
  const out = {};
  for (const [key, [from, to]] of Object.entries(ranges)) {
    const all = q.all(from, to);
    const items = all.slice(0, TOP_LIMIT).map((r, i) => ({
      rank: i + 1, id: r.id, nick: r.nick, avatarVer: r.avatar_ver || 0, pages: r.pages, me: r.id === ctx.user.id,
    }));
    // читатель не вошёл в топ — показываем его место отдельной строкой (администратору — нет, он не участвует)
    let me = null;
    if (!ctx.user.isAdmin) {
      const i = all.findIndex((r) => r.id === ctx.user.id);
      if (i >= TOP_LIMIT) me = { rank: i + 1, pages: all[i].pages };
    }
    out[key] = { items, me, readers: all.length };
  }
  sendJson(ctx.res, 200, out, { 'Cache-Control': 'no-store' });
});

route('DELETE', '/api/progress/:id', (ctx) => {
  requireUser(ctx);
  db.prepare('DELETE FROM progress WHERE user_id = ? AND book_id = ?').run(ctx.user.id, Number(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true });
});

// --- Серия чтения («огонёк»). День засчитывается, только когда человек прочитал хотя бы страницу.
// Дату присылает устройство (его местный день); принимаем только «сегодня» с запасом на часовые пояса.
const DAY_MS = 86400000;
const dayNum = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};

route('POST', '/api/streak', async (ctx) => {
  requireUser(ctx);
  const body = await readJson(ctx.req);
  const day = String(body.day || '');
  const n = /^\d{4}-\d{2}-\d{2}$/.test(day) ? dayNum(day) : NaN;
  if (!Number.isFinite(n) || new Date(n * DAY_MS).toISOString().slice(0, 10) !== day || Math.abs(n - Math.floor(now() / DAY_MS)) > 1) {
    throw new HttpError(400, 'Некорректная дата');
  }
  const u = db.prepare('SELECT streak, best_streak, last_read_day FROM users WHERE id = ?').get(ctx.user.id);
  let streak = u.streak;
  let best = u.best_streak;
  let last = u.last_read_day;
  const lastN = last ? dayNum(last) : -1e9;
  if (body.read === true && n > lastN) {
    streak = n - lastN === 1 ? streak + 1 : 1; // вчера читал — серия продолжается, иначе начинается заново
    best = Math.max(best, streak);
    last = day;
    db.prepare('UPDATE users SET streak = ?, best_streak = ?, last_read_day = ? WHERE id = ?').run(streak, best, last, ctx.user.id);
  }
  const lastNow = last ? dayNum(last) : -1e9;
  const alive = n - lastNow <= 1; // читал сегодня или вчера — серия ещё жива
  sendJson(ctx.res, 200, { streak: alive ? streak : 0, best, today: lastNow === n });
});

// --- Закладки и выделения (один документ на пользователя и книгу)
const HL_COLORS = ['yellow', 'green', 'blue', 'pink'];
const INK_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];
const TOPIC_MAX = 40;
const num01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const cleanId = (v) => String(v ?? '').replace(/[^\w-]/g, '').slice(0, 40);

function cleanAnnotations(body, pages) {
  const maxPage = pages > 0 ? pages : 100000;
  const pageOf = (v) => {
    const p = parseInt(v, 10);
    return Number.isFinite(p) && p >= 1 && p <= maxPage ? p : 0;
  };
  const bookmarks = [];
  for (const b of Array.isArray(body.bookmarks) ? body.bookmarks.slice(0, 2000) : []) {
    const page = pageOf(b?.page);
    if (!page) continue;
    bookmarks.push({ id: cleanId(b.id) || `b${page}`, page, createdAt: Number(b.createdAt) || now() });
  }
  const highlights = [];
  for (const h of Array.isArray(body.highlights) ? body.highlights.slice(0, 5000) : []) {
    const page = pageOf(h?.page);
    if (!page || !Array.isArray(h.rects)) continue;
    const rects = h.rects
      .slice(0, 200)
      .map((r) => (Array.isArray(r) ? r.slice(0, 4).map(num01) : null))
      .filter((r) => r && r.length === 4 && r[2] > 0 && r[3] > 0);
    if (!rects.length) continue;
    highlights.push({
      id: cleanId(h.id) || `h${highlights.length}`,
      page,
      rects,
      text: String(h.text ?? '').slice(0, 2000),
      color: HL_COLORS.includes(h.color) ? h.color : 'yellow',
      createdAt: Number(h.createdAt) || now(),
    });
  }
  // рисунки маркером: прямые отрезки p = [x0, y0, x1, y1] в долях страницы, w — толщина в долях ширины
  const strokes = [];
  for (const s of Array.isArray(body.strokes) ? body.strokes.slice(0, 5000) : []) {
    const page = pageOf(s?.page);
    if (!page || !Array.isArray(s.p) || s.p.length !== 4) continue;
    const p = s.p.map((v) => Math.round(num01(v) * 10000) / 10000);
    const w = Math.round(Math.min(0.08, Math.max(0.002, Number(s.w) || 0.02)) * 10000) / 10000;
    strokes.push({
      id: cleanId(s.id) || `s${strokes.length}`,
      page,
      color: INK_COLORS.includes(s.color) ? s.color : 'yellow',
      w,
      p,
      createdAt: Number(s.createdAt) || now(),
    });
  }
  // темы выделений: название для каждого цвета (например, жёлтый — «Акыда»)
  const topics = {};
  if (body.topics && typeof body.topics === 'object') {
    for (const c of HL_COLORS) {
      const name = String(body.topics[c] ?? '').replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX);
      if (name) topics[c] = name;
    }
  }
  return { bookmarks, highlights, strokes, topics, legendDone: body.legendDone === true };
}

route('GET', '/api/annotations/:id', (ctx) => {
  requireUser(ctx);
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  const row = db.prepare('SELECT data, updated_at FROM annotations WHERE user_id = ? AND book_id = ?').get(ctx.user.id, b.id);
  let data = { bookmarks: [], highlights: [], strokes: [], topics: {}, legendDone: false };
  if (row) { try { data = { ...data, ...JSON.parse(row.data) }; } catch { /* пусто */ } }
  sendJson(ctx.res, 200, { ...data, updatedAt: row ? row.updated_at : 0 }, { 'Cache-Control': 'no-store' });
});

// Все закладки и выделения пользователя по всем книгам (для раздела в профиле). Координаты выделений не отдаём.
function allAnnotations(userId) {
  const rows = db
    .prepare(
      `SELECT a.data, b.id, b.title, b.author, b.pages FROM annotations a
       JOIN books b ON b.id = a.book_id WHERE a.user_id = ? ORDER BY a.updated_at DESC`
    )
    .all(userId);
  const books = [];
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.data); } catch { continue; }
    const bookmarks = (Array.isArray(d.bookmarks) ? d.bookmarks : []).map((b) => ({ id: b.id, page: b.page, createdAt: b.createdAt }));
    const highlights = (Array.isArray(d.highlights) ? d.highlights : []).map((h) => ({ id: h.id, page: h.page, text: h.text, color: h.color, createdAt: h.createdAt }));
    if (!bookmarks.length && !highlights.length) continue;
    books.push({ id: r.id, title: r.title, author: r.author, pages: r.pages, topics: d.topics && typeof d.topics === 'object' ? d.topics : {}, bookmarks, highlights });
  }
  return books;
}

route('GET', '/api/my-annotations', (ctx) => {
  requireUser(ctx);
  sendJson(ctx.res, 200, { books: allAnnotations(ctx.user.id) }, { 'Cache-Control': 'no-store' });
});

route('PUT', '/api/annotations/:id', async (ctx) => {
  requireUser(ctx);
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  const body = await readJson(ctx.req, 1024 * 1024);
  const data = cleanAnnotations(body || {}, b.pages);
  const t = now();
  db.prepare(
    `INSERT INTO annotations (user_id, book_id, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, book_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(ctx.user.id, b.id, JSON.stringify(data), t);
  sendJson(ctx.res, 200, { ...data, updatedAt: t });
});

// Удаление закладок и выделений из профиля: {items: [{book, kind: 'bookmark' | 'highlight', id}]}.
// Одним запросом можно убрать одну заметку, целую тему или всё сразу.
route('POST', '/api/my-annotations/delete', async (ctx) => {
  requireUser(ctx);
  const body = await readJson(ctx.req, 1024 * 1024);
  const items = Array.isArray(body.items) ? body.items.slice(0, 10000) : [];
  const drop = new Map(); // book -> {bookmark: Set, highlight: Set}
  for (const it of items) {
    const book = Number(it?.book);
    const kind = it?.kind === 'bookmark' || it?.kind === 'highlight' ? it.kind : '';
    const id = String(it?.id ?? '');
    if (!Number.isInteger(book) || !kind || !id) continue;
    if (!drop.has(book)) drop.set(book, { bookmark: new Set(), highlight: new Set() });
    drop.get(book)[kind].add(id);
  }
  let removed = 0;
  const t = now();
  const get = db.prepare('SELECT data FROM annotations WHERE user_id = ? AND book_id = ?');
  const put = db.prepare('UPDATE annotations SET data = ?, updated_at = ? WHERE user_id = ? AND book_id = ?');
  db.exec('BEGIN');
  try {
    for (const [book, sets] of drop) {
      const row = get.get(ctx.user.id, book);
      if (!row) continue;
      let d;
      try { d = JSON.parse(row.data); } catch { continue; }
      const bms = Array.isArray(d.bookmarks) ? d.bookmarks : [];
      const hls = Array.isArray(d.highlights) ? d.highlights : [];
      const bms2 = bms.filter((b) => !sets.bookmark.has(String(b.id)));
      const hls2 = hls.filter((h) => !sets.highlight.has(String(h.id)));
      const n = bms.length - bms2.length + (hls.length - hls2.length);
      if (!n) continue;
      removed += n;
      put.run(JSON.stringify({ ...d, bookmarks: bms2, highlights: hls2 }), t, ctx.user.id, book);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  sendJson(ctx.res, 200, { removed, books: allAnnotations(ctx.user.id) });
});

// --- «Читает прямо сейчас»: открытая читалка раз в минуту сообщает, какая книга открыта (book: 0 — закрыта)
route('POST', '/api/reading-now', async (ctx) => {
  requireUser(ctx);
  const body = await readJson(ctx.req);
  const id = Number(body.book) || 0;
  if (id && !getBook(id)) throw new HttpError(404, 'Книга не найдена');
  db.prepare('UPDATE users SET now_book_id = ?, now_at = ? WHERE id = ?').run(id, id ? now() : 0, ctx.user.id);
  sendJson(ctx.res, 200, { ok: true });
});

// --- Резервная копия (только администратор): скачать одним файлом / восстановить из него
route('GET', '/api/admin/backup', async (ctx) => {
  requireAdmin(ctx);
  await writeBackup({ db, dataDir: DATA_DIR, uploadDir: UPLOAD_DIR, res: ctx.res });
});

route('POST', '/api/admin/restore', async (ctx) => {
  requireAdmin(ctx);
  if (ctx.req.headers['x-restore-confirm'] !== 'yes') throw new HttpError(400, 'Нужно подтверждение восстановления');
  let info;
  try {
    info = await receiveRestore({ req: ctx.req, dataDir: DATA_DIR });
  } catch (e) {
    throw new HttpError(400, e.message || 'Не удалось прочитать резервную копию');
  }
  sendJson(ctx.res, 200, { ok: true, files: info.files });
  // перезапуск: менеджер процессов (systemd, Railway) поднимет сервер снова, и данные подменятся при старте
  setTimeout(() => { try { db.close(); } catch { /* ok */ } process.exit(3); }, 700);
});

// --- Профиль
route('GET', '/api/stats', (ctx) => {
  requireUser(ctx);
  const one = (sql) => db.prepare(sql).get(ctx.user.id).c;
  const notes = allAnnotations(ctx.user.id);
  sendJson(ctx.res, 200, {
    bookmarks: notes.reduce((n, b) => n + b.bookmarks.length, 0),
    highlights: notes.reduce((n, b) => n + b.highlights.length, 0),
    reading: one(
      `SELECT COUNT(*) AS c FROM progress p JOIN books b ON b.id = p.book_id
       WHERE p.user_id = ? AND (b.pages = 0 OR p.page < b.pages)`
    ),
    finished: one(
      `SELECT COUNT(*) AS c FROM progress p JOIN books b ON b.id = p.book_id
       WHERE p.user_id = ? AND b.pages > 0 AND p.page >= b.pages`
    ),
    favorites: one('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?'),
    since: db.prepare('SELECT created_at FROM users WHERE id = ?').get(ctx.user.id)?.created_at || null,
  });
});

// --- Пользователи (только администратор): кто что читает, серии, когда был в сети
route('GET', '/api/admin/users', (ctx) => {
  requireAdmin(ctx);
  const t = now();
  const today = Math.floor(t / DAY_MS);
  const users = db.prepare('SELECT id, nick, is_admin, created_at, streak, best_streak, last_read_day, last_seen_at, now_book_id, now_at, phone, avatar_ver FROM users').all();
  const devs = new Map();
  for (const s of db.prepare('SELECT user_id, ua, created_at, last_used_at FROM sessions WHERE expires_at > ? ORDER BY last_used_at DESC, created_at DESC').all(t)) {
    if (!devs.has(s.user_id)) devs.set(s.user_id, []);
    devs.get(s.user_id).push({ label: deviceLabel(s.ua), createdAt: s.created_at || 0, lastUsedAt: s.last_used_at || 0 });
  }
  const NOW_MS = 150000; // сигнал читалки приходит раз в минуту; свежее 2,5 минут — человек читает сейчас
  const pageOfBook = db.prepare('SELECT p.page, b.id, b.title, b.author, b.pages FROM books b LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ? WHERE b.id = ?');
  const bookInfo = (r) => ({ id: r.book_id, title: r.title, author: r.author, pages: r.pages });
  const byUser = new Map(users.map((u) => [u.id, { reading: [], finished: [], want: [], lastProgress: 0 }]));
  const prog = db.prepare(
    `SELECT p.user_id, p.book_id, p.page, p.updated_at, b.title, b.author, b.pages
     FROM progress p JOIN books b ON b.id = p.book_id ORDER BY p.updated_at DESC`
  ).all();
  for (const r of prog) {
    const o = byUser.get(r.user_id);
    if (!o) continue;
    o.lastProgress = Math.max(o.lastProgress, r.updated_at);
    const item = { ...bookInfo(r), page: r.page, updatedAt: r.updated_at };
    (r.pages > 0 && r.page >= r.pages ? o.finished : o.reading).push(item);
  }
  const favs = db.prepare(
    `SELECT f.user_id, f.book_id, f.created_at, b.title, b.author, b.pages
     FROM favorites f JOIN books b ON b.id = f.book_id ORDER BY f.created_at DESC`
  ).all();
  for (const r of favs) byUser.get(r.user_id)?.want.push({ ...bookInfo(r), addedAt: r.created_at });
  const out = users.map((u) => {
    const o = byUser.get(u.id);
    const lastN = u.last_read_day ? dayNum(u.last_read_day) : -1e9;
    const alive = today - lastN <= 1; // читал сегодня или вчера — серия жива
    let readingNow = null;
    if (u.now_book_id && t - u.now_at < NOW_MS) {
      const r = pageOfBook.get(u.id, u.now_book_id);
      if (r) readingNow = { id: r.id, title: r.title, author: r.author, pages: r.pages, page: r.page || 1 };
    }
    return {
      id: u.id,
      nick: u.nick,
      isAdmin: !!u.is_admin,
      isMe: u.id === ctx.user.id,
      phone: u.phone || '',
      avatarVer: u.avatar_ver || 0,
      devices: devs.get(u.id) || [],
      readingNow,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at || o.lastProgress || 0, // у старых аккаунтов времени входа нет — берём последнее чтение
      streak: alive ? u.streak : 0,
      bestStreak: u.best_streak,
      lastReadDay: u.last_read_day || '',
      reading: o.reading,
      finished: o.finished,
      want: o.want,
    };
  }).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  sendJson(ctx.res, 200, { users: out, serverTime: t }, { 'Cache-Control': 'no-store' });
});

// Управление аккаунтами (только администратор).
// Пароли хранятся только в виде необратимого хэша, поэтому прочитать пароль нельзя — можно задать новый.
const getUserOr404 = (id) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  return u;
};

route('DELETE', '/api/admin/users/:id', (ctx) => {
  requireAdmin(ctx);
  const u = getUserOr404(ctx.params.id);
  if (u.id === ctx.user.id) throw new HttpError(400, 'Нельзя удалить свой собственный аккаунт');
  // закладки, выделения, прогресс, избранное и сессии удаляются каскадом
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  try { fs.unlinkSync(avatarFile(u.id)); } catch { /* аватарки не было */ }
  seenAt.delete(u.id);
  sendJson(ctx.res, 200, { ok: true });
});

route('POST', '/api/admin/users/:id/password', async (ctx) => {
  requireAdmin(ctx);
  const u = getUserOr404(ctx.params.id);
  const body = await readJson(ctx.req);
  const password = String(body.password || '');
  if (password.length < 6 || password.length > 200) throw new HttpError(400, 'Пароль должен быть не короче 6 символов');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hashPassword(password, salt), salt, u.id);
  // со старым паролем войти уже нельзя — выходим со всех устройств (кроме текущего, если админ меняет себе)
  if (u.id === ctx.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, ctx.user.token);
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  sendJson(ctx.res, 200, { ok: true });
});

// Смена ника (он же логин): одни и те же правила для администратора и для самого человека
function renameUser(u, raw) {
  const nick = String(raw || '').trim();
  if (!NICK_RE.test(nick)) throw new HttpError(400, 'Ник: 3–24 символа, только латиница, цифры и «_»');
  const clash = db.prepare('SELECT id FROM users WHERE nick = ? AND id != ?').get(nick, u.id);
  if (clash) throw new HttpError(409, 'Такой ник уже занят');
  // вход под ADMIN_NICK автоматически даёт права администратора — не отдаём их через переименование
  if (ADMIN_NICK && nick.toLowerCase() === ADMIN_NICK && u.nick.toLowerCase() !== ADMIN_NICK) {
    throw new HttpError(400, 'Этот ник зарезервирован за администратором');
  }
  db.prepare('UPDATE users SET nick = ? WHERE id = ?').run(nick, u.id);
  return nick;
}

route('POST', '/api/admin/users/:id/nick', async (ctx) => {
  requireAdmin(ctx);
  const u = getUserOr404(ctx.params.id);
  const body = await readJson(ctx.req);
  sendJson(ctx.res, 200, { ok: true, nick: renameUser(u, body.nick) });
});

// Свой ник может сменить любой вошедший пользователь; сессия и пароль остаются прежними
route('PUT', '/api/nick', async (ctx) => {
  requireUser(ctx);
  const u = db.prepare('SELECT id, nick FROM users WHERE id = ?').get(ctx.user.id);
  const body = await readJson(ctx.req);
  sendJson(ctx.res, 200, { nick: renameUser(u, body.nick) });
});

route('GET', '/healthz', (ctx) => {
  ctx.res.writeHead(200, { 'Content-Type': 'text/plain' });
  ctx.res.end('ok');
});

// ---------- HTTP-сервер ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
  if (MOVED && (req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
    // главная страница сайта + окно «Сайт переехал» (появляется при каждом открытии, закрывается крестиком)
    const page = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const body = Buffer.from(page.replace(/<\/body>/i, () => movedOverlayHtml(MOVED) + '</body>'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Robots-Tag': 'noindex',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (!isApi) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Метод не поддерживается' });
    return serveStatic(req, res, url.pathname);
  }

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const ctx = { req, res, params, query: url.searchParams, ip: clientIp(req), user: currentUser(req) };
    if (url.pathname.startsWith('/api/')) { touchSeen(ctx.user); touchSession(ctx.user?.token); }
    return r.handler(ctx);
  }
  const known = routes.some((r) => r.re.test(url.pathname));
  sendJson(res, known ? 405 : 404, { error: known ? 'Метод не поддерживается' : 'Не найдено' });
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handle(req, res))
    .catch((err) => {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) return res.destroy();
      const status = err instanceof HttpError ? err.status : 500;
      const headers = status === 413 ? { Connection: 'close' } : {};
      sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Внутренняя ошибка сервера' }, headers);
    });
});

server.requestTimeout = 0; // большие PDF могут грузиться долго
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000; // чуть больше, чем у прокси Railway

if (process.env.AUTO_BACKUP !== '0') startAutoBackup({ db, dataDir: DATA_DIR });

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`Библиотека запущена: http://localhost:${PORT}  (данные: ${DATA_DIR})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
