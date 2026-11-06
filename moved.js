// Страница «Сайт переехал». Включается переменной окружения MOVED_TO=https://новый-адрес
// (например, на старом хостинге после переезда). Без MOVED_TO сайт работает как обычно.

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function cleanUrl(value, fallback = '') {
  const v = String(value || '').trim();
  if (!v) return fallback;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href.replace(/\/$/, '');
  } catch {}
  console.warn(`Игнорирую некорректный адрес: ${v}`);
  return fallback;
}

export function movedConfig(env) {
  const to = cleanUrl(env.MOVED_TO);
  if (!to) return null;
  return {
    to,
    telegram: cleanUrl(env.MOVED_TELEGRAM, 'https://t.me/maktabatul_ulum'),
    instagram: cleanUrl(env.MOVED_INSTAGRAM, 'https://www.instagram.com/maktabal_ulum'),
  };
}

const TG_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.9 4.3 18.7 19.5c-.2 1-.9 1.3-1.7.8l-4.8-3.6-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.2 1.8 11.7c-1-.3-1-1 .2-1.5L20.3 3.1c.9-.3 1.6.2 1.6 1.2z"/></svg>';
const IG_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>';

export function movedPageHtml({ to, telegram, instagram }) {
  const host = new URL(to).host;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Сайт переехал — مَكْتَبَةُ الْعُلُوم</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(to)}/">
<meta name="theme-color" content="#f4efe4">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232d4a3e'/%3E%3Cpath d='M16 44V20c6-2 12-2 16 2 4-4 10-4 16-2v24c-6-2-12-2-16 2-4-4-10-4-16-2z' fill='none' stroke='%23e9d9a6' stroke-width='3' stroke-linejoin='round'/%3E%3Cpath d='M32 22v24' stroke='%23e9d9a6' stroke-width='3'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@700&family=Onest:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --bg: #f4efe4; --card: #fbf8f1; --ink: #1d2a24; --muted: #6b7268; --line: #d9d0ba; --green: #2d4a3e; --on-green: #f4efe4; --gold: #b08a3e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151b18; --card: #1f2723; --ink: #ece6d6; --muted: #98a095; --line: #333d37; --green: #86b39e; --on-green: #10241b; --gold: #d2b26a; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { background: var(--bg); color: var(--ink); font: 16px/1.55 Onest, system-ui, -apple-system, "Segoe UI", sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px 16px; }
  main { width: 100%; max-width: 460px; background: var(--card); border: 1px solid var(--line); border-radius: 22px;
         padding: 32px 26px 26px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.06); }
  .ar { font-family: Amiri, "Traditional Arabic", serif; font-weight: 700; font-size: 30px; line-height: 1.3; color: var(--green); margin: 0; }
  .ru { margin: 2px 0 22px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.25; font-weight: 600; }
  p { margin: 0 0 14px; color: var(--ink); }
  .addr { display: inline-block; margin: 2px 0 18px; padding: 6px 12px; border-radius: 10px; border: 1px dashed var(--line);
          font-weight: 600; color: var(--green); word-break: break-all; }
  .go { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 52px; padding: 12px 18px;
        border-radius: 14px; background: var(--green); color: var(--on-green); font-weight: 600; font-size: 17px; text-decoration: none;
        transition: transform .12s, filter .12s; }
  .go:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .go:focus-visible, .soc:focus-visible { outline: 3px solid var(--gold); outline-offset: 3px; }
  .note { margin: 14px 0 0; font-size: 14px; color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0 18px; }
  .help { margin: 0 0 14px; font-size: 15px; }
  .socs { display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }
  .soc { display: inline-flex; align-items: center; gap: 10px; min-height: 48px; padding: 10px 16px; border: 1px solid var(--line);
         border-radius: 14px; background: var(--bg); color: var(--ink); text-decoration: none; font-weight: 500;
         transition: transform .12s, border-color .12s; }
  .soc:hover { transform: translateY(-1px); border-color: var(--green); }
  .soc svg { width: 24px; height: 24px; flex: none; color: var(--green); }
</style>
</head>
<body>
<main>
  <p class="ar" lang="ar" dir="rtl">مَكْتَبَةُ الْعُلُوم</p>
  <p class="ru">Библиотека знаний</p>
  <h1>Сайт переехал</h1>
  <p>Библиотека теперь работает по новому адресу:</p>
  <span class="addr">${esc(host)}</span>
  <a class="go" id="go" href="${esc(to)}/">Перейти на новый сайт →</a>
  <p class="note">Аккаунты, книги и прогресс чтения перенесены. Входите со своим прежним ником и паролем. Сохраните новый адрес в закладки.</p>
  <hr>
  <p class="help">Забыли ник или пароль, или не получается войти? Напишите нам — поможем:</p>
  <div class="socs">
    <a class="soc" href="${esc(telegram)}" target="_blank" rel="noopener noreferrer" aria-label="Написать в Telegram">${TG_SVG}<span>Telegram</span></a>
    <a class="soc" href="${esc(instagram)}" target="_blank" rel="noopener noreferrer" aria-label="Написать в Instagram">${IG_SVG}<span>Instagram</span></a>
  </div>
</main>
<script>
  // сохраняем раздел сайта (#catalog и т.п.), чтобы человек попал туда же на новом адресе
  try { if (location.hash) { var a = document.getElementById('go'); a.href = a.href.replace(/#.*$/, '') + location.hash; } } catch (e) {}
</script>
</body>
</html>`;
}
