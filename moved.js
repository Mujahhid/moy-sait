// Окно «Сайт переехал». Включается переменной окружения MOVED_TO=https://новый-адрес
// (например, на старом хостинге после переезда). Окно появляется поверх сайта при каждом
// открытии страницы; крестиком его можно закрыть и продолжить пользоваться сайтом.
// Без MOVED_TO сайт работает как обычно.

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
const X_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// Разметка окна: вставляется в index.html перед </body>. Цвета берутся из тем сайта (style.css).
export function movedOverlayHtml({ to, telegram, instagram }) {
  const host = new URL(to).host;
  return `
<div class="mv-back" id="mv-back">
  <div class="mv-card" role="dialog" aria-modal="true" aria-labelledby="mv-title">
    <button type="button" class="mv-x" id="mv-x" aria-label="Закрыть и остаться на этом сайте" title="Закрыть">${X_SVG}</button>
    <p class="mv-ar" lang="ar" dir="rtl">مَكْتَبَةُ الْعُلُوم</p>
    <h2 id="mv-title">Сайт переехал</h2>
    <p>Библиотека теперь работает по новому адресу:</p>
    <span class="mv-addr">${esc(host)}</span>
    <a class="mv-go" id="mv-go" href="${esc(to)}/">Перейти на новый сайт →</a>
    <p class="mv-note">Аккаунты, книги и прогресс перенесены — входите со своим прежним ником и паролем.
      Прогресс, сохранённый на этом старом адресе после переезда, на новый сайт не попадёт.</p>
    <hr>
    <p class="mv-help">Забыли ник или пароль, или не получается войти? Напишите нам — поможем:</p>
    <div class="mv-socs">
      <a class="mv-soc" href="${esc(telegram)}" target="_blank" rel="noopener noreferrer" aria-label="Написать в Telegram">${TG_SVG}<span>Telegram</span></a>
      <a class="mv-soc" href="${esc(instagram)}" target="_blank" rel="noopener noreferrer" aria-label="Написать в Instagram">${IG_SVG}<span>Instagram</span></a>
    </div>
    <button type="button" class="mv-stay" id="mv-stay">Остаться здесь</button>
  </div>
</div>
<style>
  .mv-back { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
             padding: 16px; background: rgba(10, 16, 13, .55); overflow-y: auto; }
  .mv-back[hidden] { display: none; }
  .mv-card { position: relative; width: 100%; max-width: 440px; margin: auto; background: var(--card, #fbf8f1); color: var(--ink, #1d2a24);
             border: 1px solid var(--line, #d9d0ba); border-radius: 22px; padding: 30px 24px 18px; text-align: center;
             box-shadow: 0 20px 60px rgba(0,0,0,.25); font-family: Onest, system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
  .mv-card p { margin: 0 0 12px; }
  .mv-x { position: absolute; top: 10px; right: 10px; width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center;
          border: 0; border-radius: 12px; background: transparent; color: var(--muted, #6b7268); cursor: pointer; }
  .mv-x:hover { background: rgba(127,127,127,.12); color: var(--ink, #1d2a24); }
  .mv-x svg { width: 22px; height: 22px; }
  .mv-ar { font-family: Amiri, "Traditional Arabic", serif; font-weight: 700; font-size: 26px; line-height: 1.3; color: var(--green, #2d4a3e); }
  .mv-card h2 { margin: 0 0 8px; font-size: 23px; line-height: 1.25; font-weight: 600; }
  .mv-addr { display: inline-block; margin: 0 0 16px; padding: 6px 12px; border-radius: 10px; border: 1px dashed var(--line, #d9d0ba);
             font-weight: 600; color: var(--green, #2d4a3e); word-break: break-all; }
  .mv-go { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 50px; padding: 12px 18px; border-radius: 14px;
           background: var(--green, #2d4a3e); color: var(--card, #fbf8f1); font-weight: 600; font-size: 17px; text-decoration: none; }
  .mv-go:hover { filter: brightness(1.08); }
  .mv-note { margin-top: 12px !important; font-size: 14px; color: var(--muted, #6b7268); }
  .mv-card hr { border: 0; border-top: 1px solid var(--line, #d9d0ba); margin: 18px 0 14px; }
  .mv-help { font-size: 15px; }
  .mv-socs { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
  .mv-soc { display: inline-flex; align-items: center; gap: 9px; min-height: 46px; padding: 9px 15px; border: 1px solid var(--line, #d9d0ba);
            border-radius: 14px; color: var(--ink, #1d2a24); text-decoration: none; font-weight: 500; }
  .mv-soc:hover { border-color: var(--green, #2d4a3e); }
  .mv-soc svg { width: 24px; height: 24px; color: var(--green, #2d4a3e); }
  .mv-stay { margin-top: 14px; min-height: 44px; padding: 8px 14px; border: 0; background: none; color: var(--muted, #6b7268);
             font: inherit; font-size: 14px; text-decoration: underline; cursor: pointer; }
  .mv-x:focus-visible, .mv-go:focus-visible, .mv-soc:focus-visible, .mv-stay:focus-visible { outline: 3px solid var(--green, #2d4a3e); outline-offset: 3px; }
  html.mv-open, html.mv-open body { overflow: hidden; }
</style>
<script>
(function () {
  var back = document.getElementById('mv-back');
  if (!back) return;
  var root = document.documentElement;
  root.classList.add('mv-open');
  function close() { back.hidden = true; root.classList.remove('mv-open'); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.getElementById('mv-x').addEventListener('click', close);
  document.getElementById('mv-stay').addEventListener('click', close);
  back.addEventListener('click', function (e) { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  // сохраняем раздел (#catalog и т.п.), чтобы человек попал туда же на новом адресе
  var go = document.getElementById('mv-go');
  function syncHash() { go.href = go.href.replace(/#.*$/, '') + (location.hash || ''); }
  syncHash(); window.addEventListener('hashchange', syncHash);
  setTimeout(function () { try { go.focus(); } catch (e) {} }, 50);
})();
</script>
`;
}
