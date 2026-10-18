// Сервер библиотеки. Только встроенные модули Node.js (>= 22.13), npm install не нужен.
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { writeBackup, receiveRestore, applyPendingRestore, startAutoBackup } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Настройки (переменные окружения) ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PDF_MB = Number(process.env.MAX_PDF_MB || 200);
const ADMIN_NICK = (process.env.ADMIN_NICK || '').trim().toLowerCase();
const REGISTRATION_OPEN = (process.env.REGISTRATION || 'open') !== 'closed';
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
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token, userId, now() + SESSION_DAYS * 86400000
  );
  return sessionCookie(req, token, SESSION_DAYS * 86400);
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.nick, u.is_admin, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, nick: row.nick, isAdmin: !!row.is_admin, token };
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
  sendJson(ctx.res, 200, { user: { id, nick, isAdmin: !!isAdmin } }, { 'Set-Cookie': createSession(ctx.req, id) });
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
  sendJson(
    ctx.res, 200,
    { user: { id: u.id, nick: u.nick, isAdmin: !!u.is_admin } },
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
  const { id, nick, isAdmin } = ctx.user;
  sendJson(ctx.res, 200, { user: { id, nick, isAdmin }, registration });
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

route('DELETE', '/api/progress/:id', (ctx) => {
  requireUser(ctx);
  db.prepare('DELETE FROM progress WHERE user_id = ? AND book_id = ?').run(ctx.user.id, Number(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true });
});

// --- Закладки и выделения (один документ на пользователя и книгу)
const HL_COLORS = ['yellow', 'green', 'blue', 'pink'];
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
  return { bookmarks, highlights };
}

route('GET', '/api/annotations/:id', (ctx) => {
  requireUser(ctx);
  const b = getBook(ctx.params.id);
  if (!b) throw new HttpError(404, 'Книга не найдена');
  const row = db.prepare('SELECT data, updated_at FROM annotations WHERE user_id = ? AND book_id = ?').get(ctx.user.id, b.id);
  let data = { bookmarks: [], highlights: [] };
  if (row) { try { data = JSON.parse(row.data); } catch { /* пусто */ } }
  sendJson(ctx.res, 200, { ...data, updatedAt: row ? row.updated_at : 0 }, { 'Cache-Control': 'no-store' });
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
  sendJson(ctx.res, 200, {
    reading: one(
      `SELECT COUNT(*) AS c FROM progress p JOIN books b ON b.id = p.book_id
       WHERE p.user_id = ? AND (b.pages = 0 OR p.page < b.pages)`
    ),
    finished: one(
      `SELECT COUNT(*) AS c FROM progress p JOIN books b ON b.id = p.book_id
       WHERE p.user_id = ? AND b.pages > 0 AND p.page >= b.pages`
    ),
    favorites: one('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?'),
  });
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
