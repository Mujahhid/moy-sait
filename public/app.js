(() => {
  'use strict';

  /* ================= Утилиты ================= */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LANG = { ru: 'RU', ar: 'AR', en: 'EN' };
  const LANG_NAME = { ru: 'Русский', ar: 'Арабский', en: 'English' };
  const PH_COLORS = [
    ['#2d4a3e', '#1b2f26'], ['#6b3f2a', '#43261a'], ['#2f4562', '#1c2b40'],
    ['#5a3d5c', '#38243a'], ['#7a6226', '#4a3a12'], ['#3b5b57', '#22393a'],
  ];
  const PDFJS_WORKER = '/vendor/pdfjs/pdf.worker.min.mjs';
  const PDF_OPTS = {
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
    iccUrl: '/vendor/pdfjs/iccs/',
  };

  const state = {
    me: null,
    registration: true,
    route: 'home',
    q: '',
    section: '',
    lang: '',
    publisher: '',
    sections: [],
    afterLogin: null,
  };

  let toastTimer;
  function toast(msg, isErr = false, ms = 0) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || (isErr ? 4500 : 2600));
  }

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw new Error('Нет связи с сервером');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* пустой ответ */
    }
    if (!res.ok) {
      const err = new Error(data?.error || `Ошибка ${res.status}`);
      err.status = res.status;
      if (res.status === 401 && state.me && !url.startsWith('/api/login')) {
        state.me = null;
        updateNav();
        toast('Сессия истекла — войдите снова', true);
      }
      throw err;
    }
    return data;
  }

  /* ================= Книги: отрисовка ================= */
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function coverHtml(b) {
    if (b.hasCover) {
      return `<img src="/api/books/${b.id}/cover?v=${b.version}" alt="" loading="lazy" decoding="async">`;
    }
    const [c1, c2] = PH_COLORS[hashStr(b.title) % PH_COLORS.length];
    return `<div class="ph ${b.language === 'ar' ? 'ar' : ''}" style="background:linear-gradient(160deg,${c1},${c2})">
      <b dir="auto">${esc(b.title)}</b><i dir="auto">${esc(b.author)}</i></div>`;
  }

  function thumbHtml(b) {
    if (b.hasCover) return `<img src="/api/books/${b.id}/cover?v=${b.version}" alt="" loading="lazy">`;
    const [c1] = PH_COLORS[hashStr(b.title) % PH_COLORS.length];
    return `<div class="thumb" style="background:${c1}"></div>`;
  }

  const isFinished = (b) => !!(b.progress && b.pages > 0 && b.progress.page >= b.pages);

  function progressHtml(b) {
    if (!b.progress) return '';
    const p = b.progress.page;
    const pct = isFinished(b) ? 100 : b.pages > 0 ? Math.min(100, Math.round((p / b.pages) * 100)) : 0;
    const label = b.pages > 0 ? `Страница ${p} из ${b.pages} • ${pct}%` : `Страница ${p}`;
    return `<div class="pagelabel">${label}</div><div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div>`;
  }

  function offBtnHtml(b) {
    if (!state.me || !off.ok) return '';
    const busy = off.busy.get(b.id);
    const at = `data-off="${b.id}" data-v="${b.version}" data-cover="${b.hasCover ? 1 : 0}"`;
    if (busy != null) return `<button type="button" class="off-btn busy" ${at} disabled>Скачиваем… ${busy}%</button>`;
    if (isOffline(b)) return `<button type="button" class="off-btn done" ${at}>✓ Доступна офлайн</button>`;
    return `<button type="button" class="off-btn" ${at}>↓ Скачать для офлайн-чтения</button>`;
  }

  function cardHtml(b) {
    const info = [b.section, LANG_NAME[b.language], b.pages ? `${b.pages} стр.` : ''].filter(Boolean).join(' · ');
    return `<article class="card" data-card="${b.id}">
      <button type="button" class="cover" data-open="${b.id}" aria-label="Читать: ${esc(b.title)}">${coverHtml(b)}</button>
      <button type="button" class="fav ${b.favorite ? 'on' : ''}" data-fav="${b.id}" aria-pressed="${!!b.favorite}"
        aria-label="${b.favorite ? 'Убрать из «Хочу прочитать»' : 'Хочу прочитать'}">${b.favorite ? '♥' : '♡'}</button>
      <div class="meta" data-open="${b.id}" style="cursor:pointer">
        <h3 dir="auto">${esc(b.title)}</h3>
        <p class="cinfo">${esc(info)}</p>
        ${b.author ? `<p class="author" dir="auto">${esc(b.author)}</p>` : ''}
        ${progressHtml(b)}
      </div>
      <div class="actions">
        <span data-off-slot="${b.id}">${offBtnHtml(b)}</span>
      </div>
    </article>`;
  }

  /* ================= Офлайн: скачанные книги ================= */
  const PDF_CACHE = 'pdf-v1';
  const off = { ok: 'caches' in window, ids: new Map(), busy: new Map(), bulk: null };
  const pdfUrl = (b) => `/api/books/${b.id}/pdf?v=${b.version}`;
  const isOffline = (b) => off.ids.has(b.id) && off.ids.get(b.id).v === String(b.version);
  const getSet = (k, def) => { try { const v = localStorage.getItem('off_' + k); return v == null ? def : v === '1'; } catch { return def; } };
  const setSet = (k, v) => { try { localStorage.setItem('off_' + k, v ? '1' : '0'); } catch { /* ok */ } };
  const netAllowed = () => getSet('mobile', true) || navigator.connection?.type !== 'cellular';
  const fmtMB = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1).replace('.', ',') + ' ГБ'
    : n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1).replace('.', ',') + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ');
  async function refreshEstimate() {
    try {
      const est = await navigator.storage?.estimate?.();
      off.est = est || null;
    } catch { off.est = null; }
    const el = $('#off-est');
    if (el) el.innerHTML = estHtml();
  }
  function estHtml() {
    const e = off.est;
    return `${e && e.quota ? `<p class="muted">Данные сайта занимают ${fmtMB(e.usage || 0)} из доступных примерно ${fmtMB(e.quota)}.</p>` : ''}
      <p class="muted">Система может удалить данные сайта при нехватке места или если приложением долго не пользоваться — тогда книги нужно скачать снова.</p>`;
  }

  async function offlineScan() {
    if (!off.ok) return;
    try {
      const c = await caches.open(PDF_CACHE);
      const keys = await c.keys();
      const m = new Map();
      for (const k of keys) {
        const x = /\/api\/books\/(\d+)\/pdf\?v=(\w+)/.exec(k.url);
        if (!x) continue;
        const r = await c.match(k);
        m.set(Number(x[1]), { v: x[2], size: Number(r?.headers.get('content-length')) || 0 });
      }
      off.ids = m;
    } catch { /* ok */ }
  }

  function paintOff(id) {
    $$(`[data-off-slot="${id}"]`).forEach((slot) => {
      const d = slot.querySelector('[data-off]')?.dataset;
      if (d) slot.innerHTML = offBtnHtml({ id, version: d.v, hasCover: d.cover === '1' });
    });
    if (state.route === 'offline') { drawOffline(); if (!off.busy.size) refreshEstimate(); }
    updateSaveBtn();
  }

  async function downloadBook(b) {
    if (!off.ok || off.busy.has(b.id) || isOffline(b)) return true;
    if (!state.me) { openAuth('login'); return false; }
    off.busy.set(b.id, 0);
    paintOff(b.id);
    try {
      const res = await fetch(pdfUrl(b), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Не удалось скачать книгу');
      const total = Number(res.headers.get('content-length')) || 0;
      const rd = res.body.getReader();
      const chunks = [];
      let got = 0;
      let last = -1;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
        if (pct !== last) { last = pct; off.busy.set(b.id, pct); $$(`[data-off="${b.id}"]`).forEach((el) => { el.textContent = `Скачиваем… ${pct}%`; }); updateSaveBtn(); }
      }
      const blob = new Blob(chunks, { type: 'application/pdf' });
      const c = await caches.open(PDF_CACHE);
      for (const k of await c.keys()) if (new RegExp(`/api/books/${b.id}/pdf\\?`).test(k.url)) await c.delete(k);
      await c.put(pdfUrl(b), new Response(blob, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(blob.size) } }));
      off.ids.set(b.id, { v: String(b.version), size: blob.size });
      // чтобы книга открывалась без сети: данные книги, обложка и читалка тоже в кэше
      fetch(`/api/books/${b.id}`).catch(() => {});
      if (b.hasCover) fetch(`/api/books/${b.id}/cover?v=${b.version}`).catch(() => {});
      loadPdfjs().then((l) => fetch(PDFJS_WORKER).catch(() => l)).catch(() => {});
      try { navigator.storage?.persist?.(); } catch { /* ok */ }
      return true;
    } catch (e) {
      toast(navigator.onLine ? e.message || 'Не удалось скачать книгу' : 'Нет интернета — книгу не скачать', true);
      return false;
    } finally {
      off.busy.delete(b.id);
      paintOff(b.id);
    }
  }

  async function removeOffline(id) {
    try {
      const c = await caches.open(PDF_CACHE);
      for (const k of await c.keys()) if (new RegExp(`/api/books/${id}/pdf\\?`).test(k.url)) await c.delete(k);
    } catch { /* ok */ }
    off.ids.delete(id);
    paintOff(id);
  }

  async function downloadMany(list) {
    if (off.bulk) return;
    const todo = list.filter((b) => !isOffline(b));
    if (!todo.length) return;
    off.bulk = { done: 0, total: todo.length, stop: false };
    drawOffline();
    for (const b of todo) {
      if (off.bulk.stop || !netAllowed()) break;
      const ok = await downloadBook(b);
      if (!ok) break;
      off.bulk.done++;
      drawOffline();
    }
    off.bulk = null;
    drawOffline();
  }

  async function autoDownloadNew() {
    if (!off.ok || !state.me || !getSet('auto', false) || !navigator.onLine || !netAllowed()) return;
    try {
      await offlineScan();
      const { books } = await api('GET', '/api/books');
      state.offBooks = books;
      downloadMany(books);
    } catch { /* ok */ }
  }

  async function renderOffline() {
    view.innerHTML = `<div class="page-head"><h1 class="page-title">Скачанные книги</h1>
      <p class="page-sub">Скачайте книги на устройство, чтобы читать их без интернета.</p></div><div id="off-body"></div>`;
    if (!state.me) { $('#off-body').innerHTML = '<div class="empty">Войдите в аккаунт, чтобы скачивать книги.</div>'; return; }
    if (!off.ok) { $('#off-body').innerHTML = '<div class="empty">Этот браузер не умеет хранить книги офлайн.</div>'; return; }
    await offlineScan();
    ({ books: state.offBooks } = await api('GET', '/api/books'));
    drawOffline();
    refreshEstimate();
  }

  function drawOffline() {
    const box = $('#off-body');
    if (!box || state.route !== 'offline' || !state.me || !state.offBooks) return;
    const books = state.offBooks;
    const have = books.filter(isOffline);
    const missing = books.length - have.length;
    const size = have.reduce((n, b) => n + (off.ids.get(b.id)?.size || 0), 0);
    const bulk = off.bulk;
    const noType = navigator.connection && navigator.connection.type === undefined || !navigator.connection;
    box.innerHTML = `
      <section class="off-card">
        <p class="off-sum"><b>На устройстве: ${have.length} ${plural(have.length)}</b> · ${fmtMB(size)}</p>
        <div id="off-est">${estHtml()}</div>
      </section>
      <section class="off-card">
        <h2>Вся библиотека без интернета</h2>
        <p>${!books.length ? 'В библиотеке пока нет книг.' : bulk ? `Скачиваем: ${bulk.done} из ${bulk.total}…` : missing ? `Не скачано: ${missing} из ${books.length}` : `Все книги скачаны (${books.length}) — ${fmtMB(size)}`}</p>
        ${bulk ? `<div class="bar"><i style="width:${Math.round((bulk.done / bulk.total) * 100)}%"></i></div>` : ''}
        <div class="off-actions">
          ${bulk ? '<button type="button" class="pill-btn ghost" id="off-stop">Остановить</button>'
            : missing ? '<button type="button" class="pill-btn" id="off-all">Скачать все книги для офлайн-чтения</button>' : ''}
          ${have.length && !bulk ? '<button type="button" class="pill-btn ghost" id="off-clear">Удалить скачанное</button>' : ''}
        </div>
      </section>
      <section class="off-card">
        <h2>Настройки</h2>
        <label class="off-set"><input type="checkbox" data-set="open" ${getSet('open', true) ? 'checked' : ''}><span>Сохранять книгу на устройство, когда открываю её</span></label>
        <label class="off-set"><input type="checkbox" data-set="mobile" ${getSet('mobile', true) ? 'checked' : ''}><span>Скачивать по мобильной сети</span>
          ${noType ? '<small>(этот браузер не сообщает тип сети — настройка может не сработать)</small>' : ''}</label>
        <label class="off-set"><input type="checkbox" data-set="auto" ${getSet('auto', false) ? 'checked' : ''}><span>Автоматически скачивать новые книги библиотеки</span></label>
      </section>
      ${have.length ? `<section class="off-card"><h2>На устройстве</h2><p class="muted">Занято: ${fmtMB(size)}</p>
        <ul class="off-list">${have.map((b) => `<li><span dir="auto">${esc(b.title)}</span><small>${fmtMB(off.ids.get(b.id)?.size || 0)}</small>
          <button type="button" class="pill-btn ghost sm" data-off-del="${b.id}">Удалить</button></li>`).join('')}</ul></section>` : ''}`;
  }

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const ob = t.closest('[data-off]');
    if (ob) {
      e.stopPropagation();
      const id = Number(ob.dataset.off);
      const b = { id, version: ob.dataset.v, hasCover: ob.dataset.cover === '1' };
      if (isOffline(b)) { if (confirm('Удалить скачанную копию с этого устройства?')) removeOffline(id); }
      else downloadBook(b);
      return;
    }
    const del = t.closest('[data-off-del]');
    if (del) { removeOffline(Number(del.dataset.offDel)); return; }
    if (t.id === 'off-all') downloadMany(state.offBooks || []);
    else if (t.id === 'off-stop' && off.bulk) off.bulk.stop = true;
    else if (t.id === 'off-clear') {
      if (confirm('Удалить все скачанные книги с этого устройства?')) {
        for (const id of [...off.ids.keys()]) await removeOffline(id);
      }
    }
  }, true);
  document.addEventListener('change', (e) => {
    const s = e.target.closest?.('[data-set]');
    if (s) { setSet(s.dataset.set, s.checked); if (s.dataset.set === 'auto' && s.checked) autoDownloadNew(); }
  });

  /* ================= Роутинг и страницы ================= */
  const view = $('#view');

  const ROUTES = ['home', 'publishers', 'catalog', 'favorites', 'offline', 'profile', 'users'];
  function currentRoute() {
    const h = location.hash.replace(/^#/, '');
    const r = ROUTES.includes(h) ? h : 'home';
    if (r === 'profile' && !state.me) return 'home';
    if (r === 'users' && !state.me?.isAdmin) return state.me ? 'catalog' : 'home'; // раздел только для администратора
    return r === 'home' && state.me ? 'catalog' : r; // «Главная» — только окно входа для гостя
  }

  const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'книга' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'книги' : 'книг');

  function updateNav() {
    $('.tabbar [data-nav=home]').hidden = !!state.me;
    const navRoute = state.route === 'users' ? 'profile' : state.route; // подразделы профиля
    $$('.tabbar [data-nav]').forEach((el) => {
      el.classList.toggle('active', el.dataset.nav === navRoute);
      if (el.tagName === 'A') el.setAttribute('aria-current', el.dataset.nav === navRoute ? 'page' : 'false');
    });
    $('#nav-profile span').textContent = state.me ? state.me.nick : 'Профиль';
    $('#tab-register').hidden = !state.registration;
    $('#nav-offline').hidden = !state.me;
    $('#nav-top').hidden = !state.me; // пьедестал — для всех, кто вошёл
    $('#nav-offline').classList.toggle('active', state.route === 'offline');
    paintStreak();
  }

  async function render() {
    state.route = currentRoute();
    if (state.me && off.ok && !off.scanned) { off.scanned = true; await offlineScan(); }
    if (state.me && location.hash !== '#' + state.route && !['publishers', 'favorites', 'offline', 'profile', 'users'].includes(state.route)) {
      history.replaceState(null, '', '#' + state.route);
    }
    if (state.route !== 'publishers') state.publisher = '';
    updateNav();
    resetShelves();
    window.scrollTo(0, 0);
    try {
      if (state.route === 'home') await renderHome();
      else if (state.route === 'publishers') await renderPublishers();
      else if (state.route === 'catalog') await renderCatalog();
      else if (state.route === 'offline') await renderOffline();
      else if (state.route === 'profile') await renderProfile();
      else if (state.route === 'users') await renderUsers();
      else await renderFavorites();
    } catch (e) {
      view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
    // вошедшему пользователю заранее (в простое) подгружаем читалку, чтобы первая книга открывалась мгновенно
    if (state.me) (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => loadPdfjs().catch(() => {}));
  }

  const ORNAMENT = `<svg class="ornament" viewBox="0 0 120 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
    <path d="M2 7h38M80 7h38"/><path d="M60 1l5 6-5 6-5-6z"/><circle cx="46" cy="7" r="2"/><circle cx="74" cy="7" r="2"/></svg>`;

  // Гость на главной видит только окно входа и ничего больше
  function renderGuestHome() {
    let mode = 'login';
    view.innerHTML = `<section class="guest-home"><div class="guest-card">
        <h1 class="guest-title" id="g-title">Вход в аккаунт</h1>
        <p class="muted">Прогресс чтения сохранится в аккаунте и будет одинаковым на всех ваших устройствах.</p>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" class="tab active" data-gtab="login">Войти</button>
          ${state.registration ? '<button type="button" role="tab" class="tab" data-gtab="register">Регистрация</button>' : ''}
        </div>
        <form id="g-form" autocomplete="on">
          <label class="field">Ник (латиницей)
            <input name="nick" autocomplete="username" autocapitalize="off" spellcheck="false" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}">
          </label>
          <label class="field">Пароль
            <input name="password" type="password" autocomplete="current-password" required minlength="6">
          </label>
          ${regAvatarHtml('g')}
          <p class="form-error" id="g-error" role="alert"></p>
          <button class="btn primary wide" type="submit" id="g-submit">Войти</button>
        </form>
      </div></section>`;
    const form = $('#g-form');
    const ava = regAvatar('g', form, $('#g-error'));
    $$('[data-gtab]', view).forEach((t) => (t.onclick = () => {
      mode = t.dataset.gtab;
      $$('[data-gtab]', view).forEach((x) => x.classList.toggle('active', x === t));
      $('#g-title').textContent = mode === 'login' ? 'Вход в аккаунт' : 'Создать аккаунт';
      $('#g-submit').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
      form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      ava.show(mode === 'register');
      $('#g-error').textContent = '';
    }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#g-submit');
      $('#g-error').textContent = '';
      btn.disabled = true;
      try {
        const { user } = await api('POST', mode === 'login' ? '/api/login' : '/api/register', {
          nick: form.nick.value.trim(),
          password: form.password.value,
        });
        let avaFailed = false;
        if (mode === 'register' && ava.has()) {
          try { user.avatarVer = await ava.upload(); } catch { avaFailed = true; }
        }
        state.me = user;
        toast(avaFailed ? 'Аккаунт создан, но фото не загрузилось. Добавьте его в профиле.'
          : mode === 'login' ? `С возвращением, ${user.nick}!` : `Добро пожаловать, ${user.nick}!`);
        await render();
      } catch (err) {
        $('#g-error').textContent = err.message;
        btn.disabled = false;
      }
    });
    setTimeout(() => form.nick.focus({ preventScroll: true }), 30);
  }

  async function renderHome() {
    if (!state.me) return renderGuestHome();
    const [{ books }, prog] = await Promise.all([
      api('GET', '/api/books'),
      state.me ? api('GET', '/api/progress').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    ]);
    const cont = prog.items.map((i) => i.book).filter((b) => !isFinished(b)).slice(0, 6);
    const cta = state.me ? 'Открыть библиотеку' : 'Войти в читальный зал';

    view.innerHTML = `
      <section class="hero">
        ${ORNAMENT}
        <h1 lang="ar" dir="rtl">مَكْتَبَةُ الْعُلُوم</h1>
        <p class="kicker">Библиотека знаний</p>
        <p class="lead">Тихая библиотека на русском, арабском и английском. Читайте не спеша.</p>
        <button type="button" class="btn primary" id="cta">${cta}</button>
      </section>
      ${cont.length ? `<section class="shelf"><div class="shelf-head"><h2>Продолжить чтение</h2></div>
        <div class="grid">${cont.map(cardHtml).join('')}</div></section>` : ''}
      ${books.length ? `<section class="shelf"><div class="shelf-head"><h2>Книжная полка</h2>
        <a href="#catalog">Вся библиотека →</a></div>${bookcaseHtml(books)}</section>`
        : `<div class="empty" style="margin-top:32px">Пока в библиотеке нет книг.
            ${state.me?.isAdmin ? '<br><button type="button" class="btn primary" id="first-book">Добавить первую книгу</button>' : ''}</div>`}
      <p class="notice">Мы размещаем только книги из свободного доступа или с разрешения правообладателей.
        Автор или издатель может попросить убрать книгу.</p>`;

    $('#cta').onclick = () => {
      if (state.me) location.hash = '#catalog';
      else openAuth('login', () => (location.hash = '#catalog'));
    };
    const fb = $('#first-book');
    if (fb) fb.onclick = openManage;
    initShelves();
  }

  /* ---------- Полки: прокрутка вбок (колесо, перетаскивание, палец, стрелки) ---------- */
  function shelfShell(rowHtml) {
    return `<div class="bookcase">
      <button type="button" class="shelf-arrow prev" data-shelf="-1" aria-label="Прокрутить полку назад" hidden>‹</button>
      <div class="bookcase-track" tabindex="0" role="list" aria-label="Книги на полке"><div class="bookcase-row">${rowHtml}</div></div>
      <button type="button" class="shelf-arrow next" data-shelf="1" aria-label="Прокрутить полку вперёд" hidden>›</button>
    </div>`;
  }

  // главная: книги лицом, на деревянной доске
  function bookcaseHtml(books) {
    return shelfShell(books.map((b, i) => `
      <button type="button" role="listitem" class="cover spine" data-open="${b.id}" style="--h:${[220, 232, 210, 226][i % 4]}px"
        data-tip="${esc(b.title)}" data-pages="${b.pages || 0}" aria-label="Читать: ${esc(b.title)}">${coverHtml(b)}</button>`).join(''));
  }

  // каталог, издательства, избранное: книги боком, названия на корешках
  const SPINE_COLORS = ['#2d4a3e', '#4d2f4a', '#5a4630', '#6b4a1e', '#22345a', '#6b2a28', '#3b5b57', '#554226'];
  function spineHtml(b) {
    const h = hashStr(b.title);
    const height = 150 + ((h >> 3) % 81);
    const width = Math.max(36, Math.min(64, 32 + Math.round((b.pages || 0) / 22)));
    const ar = /[؀-ۿ]/.test(b.title) ? ' lang="ar"' : '';
    return `<button type="button" role="listitem" class="spine-book" data-open="${b.id}"
      style="--c:${SPINE_COLORS[h % SPINE_COLORS.length]};--h:${height}px;--w:${width}px"
      data-tip="${esc(b.title)}" data-pages="${b.pages || 0}" aria-label="Читать: ${esc(b.title)}">
      <span class="sb-title"${ar} dir="auto">${esc(b.title)}</span></button>`;
  }
  const spinesHtml = (books) => `<div class="spineshelf">${shelfShell(books.map(spineHtml).join(''))}</div>`;
  const spinesBlock = (books) => `<div class="spines-wrap"><h2 class="spines-title">На полке</h2>
    <p class="spines-sub">Нажмите на корешок, чтобы открыть книгу.</p>${spinesHtml(books)}</div>`;

  /* ---------- Плашка при наведении мыши на книгу на полке: название и число страниц ---------- */
  const tipEl = document.createElement('div');
  tipEl.className = 'book-tip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  let tipTarget = null;
  let tipTimer = 0;
  const pagesWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'страница' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'страницы' : 'страниц');
  function hideTip() {
    clearTimeout(tipTimer);
    tipTarget = null;
    tipEl.hidden = true;
  }
  function showTip(el) {
    const pages = Number(el.dataset.pages) || 0;
    tipEl.innerHTML = `<b dir="auto">${esc(el.dataset.tip)}</b>${pages ? `<span>${pages} ${pagesWord(pages)}</span>` : ''}`;
    tipEl.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), window.innerWidth - w - 8);
    let top = r.top - h - 10;
    if (top < 8) top = r.bottom + 10; // сверху нет места — показываем снизу
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  }
  // по движению мыши, а не по pointerover: если список перерисовался под курсором, плашка всё равно появится
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tip]');
    if (el && el === tipTarget) return;
    hideTip();
    if (!el || !view.contains(el)) return;
    tipTarget = el;
    tipTimer = setTimeout(() => { if (tipTarget === el && el.isConnected) showTip(el); }, 180);
  });
  document.addEventListener('pointerdown', hideTip, true);

  // телефон и планшет: долгое нажатие на книгу показывает ту же плашку (название и число страниц)
  const LONG_PRESS_MS = 450;
  const LONG_PRESS_SLOP = 10; // сдвиг пальца больше этого — это прокрутка, а не долгое нажатие
  let pressTimer = 0;
  let pressStart = null;
  let lastLongPressAt = 0;
  let tipHideTimer = 0;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; pressStart = null; };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    cancelPress();
    const el = e.target.closest?.('[data-tip]');
    if (!el || !view.contains(el)) return;
    pressStart = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      if (!el.isConnected) return;
      lastLongPressAt = Date.now();
      tipTarget = el;
      showTip(el);
      clearTimeout(tipHideTimer);
      tipHideTimer = setTimeout(() => { if (tipTarget === el) hideTip(); }, 4000);
      if (navigator.vibrate) navigator.vibrate(12);
    }, LONG_PRESS_MS);
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!pressStart || e.pointerType === 'mouse') return;
    if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > LONG_PRESS_SLOP) cancelPress();
  }, true);
  ['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, cancelPress, true));
  // после долгого нажатия отпускание пальца даёт клик: гасим его, чтобы книга не открылась
  document.addEventListener('click', (e) => {
    if (Date.now() - lastLongPressAt > 900) return;
    if (!e.target.closest?.('[data-tip]')) return;
    lastLongPressAt = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  // Android показывает системное меню при долгом нажатии на книгу — не нужно
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('[data-tip]') && view.contains(e.target) && !matchMedia('(hover: hover) and (pointer: fine)').matches) e.preventDefault();
  });

  // прокрутка прячет плашку, кроме момента, пока палец ещё держит книгу
  document.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);
  document.addEventListener('keydown', hideTip, true);

  let shelfCleanups = [];
  let spinesCleanup = null;
  function resetShelves() {
    shelfCleanups.forEach((f) => f());
    shelfCleanups = [];
    if (spinesCleanup) { spinesCleanup(); spinesCleanup = null; }
  }
  function initShelves() {
    resetShelves();
    $$('.bookcase', view).forEach((root) => shelfCleanups.push(initShelf(root)));
  }

  function initShelf(root) {
    const track = $('.bookcase-track', root);
    const prev = $('.prev', root);
    const next = $('.next', root);
    const update = () => {
      const max = track.scrollWidth - track.clientWidth;
      prev.hidden = track.scrollLeft <= 4;
      next.hidden = max <= 4 || track.scrollLeft >= max - 4;
    };
    track.addEventListener('scroll', update, { passive: true });
    // колесо мыши листает полку вбок, пока она не упрётся в край
    track.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = track.scrollWidth - track.clientWidth;
      if (max <= 0) return;
      const atEdge = (e.deltaY < 0 && track.scrollLeft <= 0) || (e.deltaY > 0 && track.scrollLeft >= max - 1);
      if (atEdge) return;
      e.preventDefault();
      track.scrollLeft += e.deltaY;
    }, { passive: false });
    // перетаскивание мышью
    let drag = null;
    track.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { x: e.clientX, left: track.scrollLeft, moved: false };
    });
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 5) drag.moved = true;
      if (drag.moved) track.scrollLeft = drag.left - dx;
    };
    const onUp = () => {
      if (drag?.moved) track.dataset.dragged = '1';
      drag = null;
      setTimeout(() => delete track.dataset.dragged, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('resize', update);
    // после перетаскивания не открываем книгу случайным кликом
    track.addEventListener('click', (e) => {
      if (track.dataset.dragged) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    root.addEventListener('click', (e) => {
      const arrow = e.target.closest('[data-shelf]');
      if (!arrow) return;
      track.scrollBy({ left: Number(arrow.dataset.shelf) * track.clientWidth * 0.8, behavior: 'smooth' });
    });
    update();
    requestAnimationFrame(update);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', update);
    };
  }

  /* ================= Издательства ================= */
  // Без выбора — сетка плиток. После выбора плитки уезжают влево списком, справа — шкаф с книгами издательства.
  // логотипы издательств (public/pub/*.jpg); сопоставление по названию без регистра, пробелов и дефисов
  const PUB_LOGOS = {
    almidad: 'al-midad', darujour: 'dar-ujour', alimtisal: 'al-imtisal',
    maktabazalzalya: 'maktaba-zalzalya', maktabatuzalzalya: 'maktaba-zalzalya', zalzalya: 'maktaba-zalzalya',
    asaribnabbas: 'asar-ibn-abbas',
    rayhan: 'rayhan', райхан: 'rayhan',
    daura: 'daura', даура: 'daura',
    ahluasar: 'ahlu-al-asar', ahlualasar: 'ahlu-al-asar', ahlulasar: 'ahlu-al-asar', ахлуасар: 'ahlu-al-asar', ахлуальасар: 'ahlu-al-asar', ахлюасар: 'ahlu-al-asar',
    baytalmagrifa: 'bayt-al-magrifa', baytalmarifa: 'bayt-al-magrifa', baytulmagrifa: 'bayt-al-magrifa', baytalmagrifah: 'bayt-al-magrifa', байтальмагрифа: 'bayt-al-magrifa', байтальмарифа: 'bayt-al-magrifa',
    minhajsunna: 'minhaj-sunna', minhajsunnah: 'minhaj-sunna', mihnajsunna: 'minhaj-sunna', minhajassunna: 'minhaj-sunna', minhajussunna: 'minhaj-sunna',
    минхаджсунна: 'minhaj-sunna', минхаджсунны: 'minhaj-sunna', минхаджассунна: 'minhaj-sunna',
    tullabalharamayn: 'tullab-al-haramayn', tullabulharamayn: 'tullab-al-haramayn', tullabalharamain: 'tullab-al-haramayn', tullabharamayn: 'tullab-al-haramayn',
    туллабальхарамайн: 'tullab-al-haramayn', туллабульхарамайн: 'tullab-al-haramayn', туллабальхарамаин: 'tullab-al-haramayn',
    fajr: 'fajr', fadjr: 'fajr', fadzhr: 'fajr', фаджр: 'fajr', фаджир: 'fajr', фаджриздательскийдом: 'fajr', издательскийдомфаджр: 'fajr',
    rushd: 'rushd', рушд: 'rushd',
    abusolikh: 'abu-solikh', abusolih: 'abu-solikh', abusalih: 'abu-solikh', абусолих: 'abu-solikh', абусалих: 'abu-solikh',
    ummah: 'ummah', umma: 'ummah', умма: 'ummah', уммах: 'ummah',
  };
  const pubLogo = (name) => PUB_LOGOS[String(name).toLowerCase().replace(/[^a-zа-яё0-9]/g, '')];
  const pubIcon = (name) => {
    const logo = pubLogo(name);
    return logo
      ? `<span class="pub-ico has-logo" aria-hidden="true"><img src="/pub/${logo}.jpg" alt="" width="52" height="52" loading="lazy" draggable="false"></span>`
      : `<span class="pub-ico" aria-hidden="true">${esc([...name][0].toUpperCase())}</span>`;
  };

  const cabinetHtml = (books) => `<div class="cabinet"><div class="cab-shelves" role="list" aria-label="Книги издательства">${
    books.map((b) => `<div class="cab-slot">${spineHtml(b)}</div>`).join('')}</div></div>`;

  async function paintPubStage() {
    const box = $('#pub-stage');
    const name = state.publisher;
    if (!box) return;
    if (!name) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="pub-loading">Расставляем книги на полки…</div>';
    let books;
    try {
      ({ books } = await api('GET', '/api/books?' + new URLSearchParams({ publisher: name })));
    } catch (e) {
      if (state.publisher === name && $('#pub-stage') === box) box.innerHTML = `<div class="empty">${esc(e.message || 'Не удалось загрузить книги')}</div>`;
      return;
    }
    if (state.publisher !== name || $('#pub-stage') !== box) return; // пока грузилось, выбрали другое
    box.innerHTML = `<div class="pub-stage-head"><h2 dir="auto">${esc(name)}</h2><p>${books.length} ${plural(books.length)}</p></div>
      ${books.length ? cabinetHtml(books) : '<div class="empty">У этого издательства пока нет книг.</div>'}`;
  }

  function syncPubLayout() {
    const layout = $('#pub-layout');
    if (!layout) return;
    layout.classList.toggle('has-sel', !!state.publisher);
    $$('.pub', layout).forEach((el) => {
      const on = el.dataset.pub === state.publisher;
      el.classList.toggle('active', on);
      el.setAttribute('aria-pressed', String(on));
    });
    const sub = $('#pub-sub');
    if (sub) sub.textContent = state.publisher ? 'Выберите другое издательство или вернитесь ко всем.' : 'Выберите издательство, чтобы увидеть его книги.';
  }

  // плавный переезд плиток из сетки в колонку (и обратно)
  function pickPublisher(name) {
    const layout = $('#pub-layout');
    if (!layout) { state.publisher = name; render(); return; }
    const items = $$('.pub', layout);
    const first = items.map((e) => e.getBoundingClientRect());
    state.publisher = name;
    syncPubLayout();
    paintPubStage();
    if (reducedMotion()) return;
    items.forEach((e, i) => {
      const r = e.getBoundingClientRect();
      const dx = first[i].left - r.left;
      const dy = first[i].top - r.top;
      if (!dx && !dy) return;
      e.style.transition = 'none';
      e.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    layout.classList.add('flying'); // на время переезда список не обрезает плитки
    void layout.offsetWidth;
    items.forEach((e) => { e.style.transition = 'transform .5s cubic-bezier(.2, .8, .2, 1)'; e.style.transform = ''; });
    setTimeout(() => { items.forEach((e) => { e.style.transition = ''; }); layout.classList.remove('flying'); }, 560);
  }

  async function renderPublishers() {
    const { publishers } = await api('GET', '/api/publishers');
    if (!publishers.length) {
      view.innerHTML = `<div class="page-head"><h1 class="page-title">Издательства</h1></div>
        <div class="empty">Здесь появятся издательства, когда вы укажете их у книг.${
          state.me?.isAdmin ? '<br><button type="button" class="btn primary" id="first-book">Добавить книгу</button>' : ''}</div>`;
      const fb = $('#first-book');
      if (fb) fb.onclick = openManage;
      return;
    }
    if (state.publisher && !publishers.some((p) => p.name === state.publisher)) state.publisher = '';
    view.innerHTML = `<div class="page-head"><h1 class="page-title">Издательства</h1><p class="page-sub" id="pub-sub"></p></div>
      <div class="pub-layout" id="pub-layout">
        <div class="pub-grid" role="group" aria-label="Издательства">
          <button type="button" class="pub-all" id="pub-all">← Все издательства</button>
          ${publishers.map((p) => `
            <button type="button" class="pub" data-pub="${esc(p.name)}" aria-pressed="false">
              ${pubIcon(p.name)}
              <span><b dir="auto">${esc(p.name)}</b><span class="sub">${p.count} ${plural(p.count)}</span></span>
            </button>`).join('')}
        </div>
        <section class="pub-stage" id="pub-stage" aria-live="polite"></section>
      </div>`;
    $('#pub-all').onclick = () => pickPublisher('');
    syncPubLayout();
    paintPubStage();
  }

  function continueCard(b) {
    const p = b.progress.page;
    const pct = isFinished(b) ? 100 : b.pages > 0 ? Math.min(100, Math.round((p / b.pages) * 100)) : 0;
    return `<article class="cr-card" role="listitem" tabindex="0" data-open="${b.id}" aria-label="Продолжить чтение: ${esc(b.title)}">
      <div class="cr-cover">${b.hasCover ? `<img src="/api/books/${b.id}/cover?v=${b.version}" alt="" loading="lazy" draggable="false">` : `<div class="cr-ph" style="background:${PH_COLORS[hashStr(b.title) % PH_COLORS.length][0]}"></div>`}</div>
      <div class="cr-body">
        <h3 dir="auto">${esc(b.title)}</h3>
        <p class="cr-author" dir="auto">${esc(b.author || 'Неизвестный автор')}</p>
        <p class="cr-pct">PDF • ${pct} %</p>
      </div>
      <button type="button" class="cr-dots" data-cr-menu="${b.id}" aria-label="Действия с книгой" title="Действия">•••</button>
    </article>`;
  }

  const crBooks = new Map();
  function closeSheet() { $('#sheet')?.remove(); document.body.classList.remove('no-scroll-sheet'); }
  function openCrSheet(b) {
    closeSheet();
    const p = b.progress?.page || 1;
    const pct = isFinished(b) ? 100 : b.pages > 0 ? Math.min(100, Math.round((p / b.pages) * 100)) : 0;
    const have = isOffline(b);
    const el = document.createElement('div');
    el.id = 'sheet';
    el.className = 'sheet-back';
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(b.title)}">
      <h3 dir="auto">${esc(b.title)}</h3>
      <p class="sheet-sub">${b.pages > 0 ? `Страница ${p} из ${b.pages} • ${pct}%` : `Страница ${p}`}</p>
      <button type="button" class="sheet-btn primary" data-sh="open">Продолжить чтение</button>
      ${off.ok ? `<button type="button" class="sheet-btn" data-sh="off">${have ? '✓ Доступна офлайн — удалить копию' : '↓ Скачать для офлайн-чтения'}</button>` : ''}
      <button type="button" class="sheet-btn danger" data-sh="remove">Убрать из «Продолжить чтение»</button>
      <button type="button" class="sheet-btn" data-sh="cancel">Отмена</button></div>`;
    el.addEventListener('click', async (ev) => {
      const act = ev.target.closest('[data-sh]')?.dataset.sh;
      if (!act && ev.target !== el) return;
      closeSheet();
      if (act === 'open') openBook(b.id);
      else if (act === 'off') { if (have) await removeOffline(b.id); else downloadBook(b); }
      else if (act === 'remove') {
        try { await api('DELETE', `/api/progress/${b.id}`); } catch (e) { toast(e.message, true); return; }
        loadContinue();
      }
    });
    document.body.appendChild(el);
    $('[data-sh="open"]', el).focus();
  }
  document.addEventListener('click', (e) => {
    const m = e.target instanceof Element && e.target.closest('[data-cr-menu]');
    if (!m) return;
    e.stopPropagation();
    const b = crBooks.get(Number(m.dataset.crMenu));
    if (b) openCrSheet(b);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  let crCleanup = null;
  async function loadContinue() {
    const box = $('#continue');
    if (!box) return;
    if (crCleanup) { crCleanup(); crCleanup = null; }
    if (!state.me) { box.innerHTML = ''; return; }
    let items = [];
    try { ({ items } = await api('GET', '/api/progress')); } catch { return; }
    if (!$('#continue')) return;
    items = items.filter((i) => i.book);
    crBooks.clear();
    items.forEach((i) => crBooks.set(i.book.id, i.book));
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<section class="cr-wrap"><h2 class="cr-title">Продолжить чтение</h2>
      <p class="cr-sub">Книга откроется на той странице, где вы остановились.</p>
      ${shelfShell(items.map((i) => continueCard(i.book)).join(''))}</section>`;
    const root = $('.bookcase', box);
    root.classList.add('cr');
    crCleanup = initShelf(root);
  }

  let searchTimer;
  async function renderCatalog() {
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Библиотека</h1></div>
      <div id="continue"></div>
      <div class="search-sticky">
        <div class="search">
          <span class="glass" aria-hidden="true">⌕</span>
          <input id="q" type="text" enterkeyhint="search" autocomplete="off"
            placeholder="Ищите по названию, автору, издательству или теме." value="${esc(state.q)}"
            aria-label="Поиск по библиотеке">
          <button type="button" class="clear" id="q-clear" aria-label="Очистить поиск" ${state.q ? '' : 'hidden'}>✕</button>
        </div>
        <p class="result-count" id="q-count" aria-live="polite"></p>
      </div>
      ${state.me ? `<a class="off-link" href="#offline"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/></svg>Скачанные книги и чтение без интернета</a>` : ''}
      <div class="toolbar"><div class="chips" id="chips"></div></div>
      <div id="spines"></div>
      <div id="grid" class="grid"></div>`;

    const q = $('#q');
    const clear = $('#q-clear');
    q.addEventListener('input', () => {
      state.q = q.value;
      clear.hidden = !q.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadCatalogGrid, 250);
    });
    clear.onclick = () => {
      q.value = '';
      state.q = '';
      clear.hidden = true;
      q.focus();
      loadCatalogGrid();
    };

    const { sections } = await api('GET', '/api/sections');
    state.sections = sections;
    if (state.section && !sections.some((s) => s.name === state.section)) state.section = '';
    if (state.lang === 'en') state.lang = '';
    drawChips();
    loadContinue();
    await loadCatalogGrid();
  }

  function drawChips() {
    const total = state.sections.reduce((n, s) => n + s.count, 0);
    const chip = (key, val, label, count) =>
      `<button type="button" class="chip ${state[key] === val ? 'active' : ''}" data-chip="${key}" data-val="${esc(val)}">${esc(label)}${
        count != null ? `<span class="n">${count}</span>` : ''
      }</button>`;
    const el = $('#chips');
    if (!el) return;
    el.innerHTML =
      chip('section', '', 'Все разделы', total) +
      state.sections.map((s) => chip('section', s.name, s.name, s.count)).join('') +
      Object.entries(LANG_NAME).filter(([k]) => k !== 'en').map(([k, v]) => chip('lang', k, v)).join('');
  }

  let gridSeq = 0;
  async function loadCatalogGrid() {
    const seq = ++gridSeq;
    const params = new URLSearchParams();
    if (state.q.trim()) params.set('q', state.q.trim());
    if (state.section) params.set('section', state.section);
    if (state.lang) params.set('lang', state.lang);
    let books;
    try {
      ({ books } = await api('GET', '/api/books?' + params));
    } catch (e) {
      if (seq === gridSeq && $('#grid')) $('#grid').innerHTML = `<div class="empty" style="grid-column:1/-1">${esc(e.message)}</div>`;
      return;
    }
    if (seq !== gridSeq || !$('#grid')) return;
    if (spinesCleanup) { spinesCleanup(); spinesCleanup = null; }
    const filtered = !!(state.q.trim() || state.section || state.lang);
    $('#q-count').textContent = !books.length ? '' : filtered ? `Найдено: ${books.length}` : `Всего: ${books.length} ${plural(books.length)}`;
    const sp = $('#spines');
    sp.innerHTML = books.length ? spinesBlock(books) : '';
    if (books.length) spinesCleanup = initShelf($('.bookcase', sp));
    $('#grid').innerHTML = books.length
      ? books.map(cardHtml).join('')
      : `<div class="empty" style="grid-column:1/-1">${
          state.q || state.section || state.lang ? 'Ничего не найдено. Попробуйте изменить запрос или фильтры.' : 'Пока в библиотеке нет книг.'
        }</div>`;
  }

  // строка книги в «Мои книги»: обложка, название, автор, прогресс и круглая кнопка «читать»
  function rowHtml(b) {
    const sub = [b.author, b.pages ? `${b.pages} стр.` : ''].filter(Boolean).join(' · ');
    return `<article class="book-row">
      <button type="button" class="row-cover" data-open="${b.id}" aria-label="Читать: ${esc(b.title)}">${thumbHtml(b)}</button>
      <div class="row-txt" data-open="${b.id}">
        <h3 dir="auto">${esc(b.title)}</h3>
        ${sub ? `<p class="row-sub" dir="auto">${esc(sub)}</p>` : ''}
        ${progressHtml(b)}
      </div>
      <button type="button" class="fav-mini ${b.favorite ? 'on' : ''}" data-fav="${b.id}" aria-pressed="${!!b.favorite}"
        aria-label="${b.favorite ? 'Убрать из «Хочу прочитать»' : 'Хочу прочитать'}">${b.favorite ? '♥' : '♡'}</button>
      <button type="button" class="row-go" data-open="${b.id}" aria-label="Читать: ${esc(b.title)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>
      </button>
    </article>`;
  }

  /* ================= Пользователи (только администратор) ================= */
  const USERS = { q: '', open: new Set(), hist: new Set(), edit: null, notice: null, timer: 0, now: 0 };
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtClock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const fmtDate = (ts) => { const d = new Date(ts); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`; };
  const ONLINE_MS = 5 * 60000;

  // «Сейчас в сети», «12 мин назад», «вчера в 14:30», «3 окт, 09:15»
  function lastSeenText(ts, nowMs) {
    if (!ts) return 'нет данных о заходах';
    const diff = nowMs - ts;
    if (diff < ONLINE_MS) return 'сейчас в сети';
    const d = new Date(ts);
    const n = new Date(nowMs);
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(n) - startOf(d)) / 86400000);
    if (diff < 3600000) return `был ${Math.max(1, Math.round(diff / 60000))} мин назад`;
    if (days === 0) return `был сегодня в ${fmtClock(d)}`;
    if (days === 1) return `был вчера в ${fmtClock(d)}`;
    return `был ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}, ${fmtClock(d)}`;
  }

  const pctOf = (b) => (b.pages > 0 ? Math.min(100, Math.round((b.page / b.pages) * 100)) : null);
  const pageText = (b) => (b.pages > 0 ? `стр. ${b.page} из ${b.pages}` : `стр. ${b.page}`);
  const agoText = (ts, nowMs) => lastSeenText(ts, nowMs).replace('был ', '').replace('сейчас в сети', 'только что');
  // случайный пароль без похожих символов (0/O, 1/l/I)
  function genPassword() {
    const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = new Uint32Array(10);
    crypto.getRandomValues(a);
    return [...a].map((n) => abc[n % abc.length]).join('');
  }

  // одна книга в истории чтения: страница, процент и полоска прогресса
  function userBookRow(b, kind, nowMs) {
    const p = kind === 'done' ? 100 : pctOf(b);
    const head = kind === 'done' ? `прочитана${p != null ? ' · 100%' : ''}` : `${pageText(b)}${p != null ? ` · ${p}%` : ''}`;
    const when = kind === 'done' ? fmtDate(b.updatedAt) : agoText(b.updatedAt, nowMs);
    return `<div class="u-book"><div class="ub-top"><b dir="auto">${esc(b.title)}</b><span>${esc(head)}</span></div>
      ${p != null ? `<div class="bar"><i style="width:${p}%"></i></div>` : ''}<small>${esc(when)}</small></div>`;
  }

  function userWantList(list) {
    if (!list.length) return '';
    return `<div class="u-list"><h5>Хочет прочитать <span>${list.length}</span></h5>
      ${list.map((b) => `<div class="u-book"><div class="ub-top"><b dir="auto">${esc(b.title)}</b><span>добавлена ${esc(fmtDate(b.addedAt))}</span></div></div>`).join('')}</div>`;
  }

  // «Что читал раньше» — сворачивается, открывается нажатием
  const userAllBooks = (u) => [
    ...u.reading.map((b) => ({ b, kind: 'reading' })),
    ...u.finished.map((b) => ({ b, kind: 'done' })),
  ].sort((x, y) => y.b.updatedAt - x.b.updatedAt);

  // exceptId — книга, которая уже показана сверху («читает сейчас» или «последнее чтение»)
  function userHistory(u, nowMs, exceptId) {
    const items = userAllBooks(u).filter((x) => x.b.id !== exceptId);
    if (!items.length) return exceptId ? '' : '<p class="muted small">Пока не открывал книги.</p>';
    return `<details class="u-hist" data-hist="${u.id}" ${USERS.hist.has(u.id) ? 'open' : ''}>
      <summary>Что читал раньше <span>${items.length}</span></summary>
      ${items.map((x) => userBookRow(x.b, x.kind, nowMs)).join('')}
    </details>`;
  }

  function userDevices(u) {
    const list = u.devices || [];
    const rows = list.length
      ? list.map((d) => `<div class="u-dev"><b>${esc(d.label)}</b>
          <span>${d.lastUsedAt ? `активно: ${esc(lastSeenText(d.lastUsedAt, USERS.now).replace('был ', ''))}` : 'давно'}${d.createdAt ? ` · вход ${esc(fmtDate(d.createdAt))}` : ''}</span></div>`).join('')
      : '<p class="muted small">Сейчас нет активных входов.</p>';
    return `<div class="u-list"><h5>Устройства, с которых вошёл <span>${list.length}</span></h5>${rows}</div>`;
  }

  // блок «Аккаунт»: логин, пароль и действия; редактирование — прямо в карточке
  function userAccount(u) {
    const ed = USERS.edit && USERS.edit.id === u.id ? USERS.edit.kind : '';
    const notice = USERS.notice && USERS.notice.id === u.id ? USERS.notice : null;
    let form = '';
    if (ed === 'nick') {
      form = `<div class="u-edit"><label>Новый логин<input type="text" id="ue-input" value="${esc(u.nick)}" maxlength="24" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <p class="form-error" id="ue-err"></p>
        <div class="u-edit-btns"><button type="button" class="btn primary small" data-uact="save">Сохранить</button><button type="button" class="btn ghost small" data-uact="cancel">Отмена</button></div></div>`;
    } else if (ed === 'pass') {
      form = `<div class="u-edit"><label>Новый пароль (не короче 6 символов)<input type="text" id="ue-input" value="${esc(USERS.edit.value)}" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <p class="form-error" id="ue-err"></p>
        <div class="u-edit-btns"><button type="button" class="btn primary small" data-uact="save">Сохранить</button>
        <button type="button" class="btn ghost small" data-uact="regen">Другой пароль</button><button type="button" class="btn ghost small" data-uact="cancel">Отмена</button></div>
        <p class="muted small">После сохранения человек выйдет со всех устройств и войдёт уже с новым паролем.</p></div>`;
    }
    return `<div class="u-acc">
      <div class="u-cred"><span>Логин (он же ник)</span><b dir="ltr">${esc(u.nick)}</b></div>
      <div class="u-cred"><span>Телефон</span><b dir="ltr">${u.phone ? esc(u.phone) : 'не указан'}</b></div>
      <div class="u-cred"><span>Пароль</span><b>скрыт</b><small>Пароли хранятся в зашифрованном виде: прочитать их нельзя, можно задать новый.</small></div>
      ${notice ? `<div class="u-notice">${esc(notice.text)}${notice.password ? `<div class="u-pw"><code>${esc(notice.password)}</code><button type="button" class="btn ghost small" data-uact="copy" data-pw="${esc(notice.password)}">Копировать</button></div>` : ''}</div>` : ''}
      ${form}
      <div class="u-actions">
        <button type="button" class="btn ghost small" data-uact="nick">Сменить логин</button>
        <button type="button" class="btn ghost small" data-uact="pass">Сбросить пароль</button>
        ${u.isMe ? '' : '<button type="button" class="btn danger small" data-uact="delete">Удалить аккаунт</button>'}
      </div></div>`;
  }

  function userCardHtml(u, nowMs) {
    const online = u.lastSeenAt && nowMs - u.lastSeenAt < ONLINE_MS;
    const open = USERS.open.has(u.id);
    const streakTxt = u.streak > 0
      ? `<span class="u-chip fire">${FLAME_SVG}${u.streak} ${daysWord(u.streak)} подряд</span>`
      : `<span class="u-chip dim">серии нет${u.bestStreak ? ` · рекорд ${u.bestStreak}` : ''}</span>`;
    // сверху: что читает прямо сейчас, а если не читает — что читал последним; всё остальное — в «Что читал раньше»
    const live = u.readingNow;
    const lastItem = live ? null : userAllBooks(u)[0] || null;
    const top = live || lastItem?.b || null;
    const topDone = !live && lastItem?.kind === 'done';
    const topP = top ? (topDone ? 100 : pctOf(top)) : null;
    const nowHtml = top
      ? `<div class="u-now ${live ? '' : 'last'}"><i class="pulse"></i><div class="u-now-tx"><span class="lbl">${live ? 'Читает сейчас' : topDone ? 'Последнее: прочитана' : 'Читал последним'}</span>
          <b dir="auto">${esc(top.title)}</b></div>
          <div class="u-prog"><i style="--p:${topP ?? 0}%"></i><span>${topDone ? 'прочитана · 100%' : `${esc(pageText(top))}${topP != null ? ` · ${topP}%` : ''}`}${live ? '' : ` · ${esc(agoText(top.updatedAt, nowMs))}`}</span></div></div>`
      : '';
    return `<details class="u-card" data-uid="${u.id}" ${open ? 'open' : ''}>
      <summary>
        ${avatarHtml(u, 'sm')}
        <div class="u-main">
          <div class="u-name"><b>${esc(u.nick)}</b>${u.isAdmin ? '<span class="badge">админ</span>' : ''}${u.isMe ? '<span class="badge dim">это вы</span>' : ''}</div>
          <div class="u-seen ${online ? 'on' : ''}"><i></i>${esc(lastSeenText(u.lastSeenAt, nowMs))}</div>
        </div>
        <div class="u-nums" aria-label="Читает, прочитал, хочет прочитать">
          <span title="Читает"><b>${u.reading.length}</b>читает</span>
          <span title="Прочитал"><b>${u.finished.length}</b>прочитал</span>
          <span title="Хочет прочитать"><b>${u.want.length}</b>хочет</span>
        </div>
      </summary>
      <div class="u-body">
        ${nowHtml}
        <div class="u-facts">
          ${streakTxt}
          ${u.streak > 0 && u.bestStreak > u.streak ? `<span class="u-chip dim">рекорд ${u.bestStreak}</span>` : ''}
          <span class="u-chip dim">регистрация ${esc(fmtDate(u.createdAt))}</span>
          ${u.lastReadDay ? `<span class="u-chip dim">последнее чтение ${esc(u.lastReadDay.split('-').reverse().join('.'))}</span>` : ''}
        </div>
        ${userAccount(u)}
        ${userDevices(u)}
        ${userHistory(u, nowMs, top?.id)}
        ${userWantList(u.want)}
      </div>
    </details>`;
  }

  async function renderUsers() {
    clearInterval(USERS.timer);
    USERS.edit = null;
    USERS.notice = null; // показанный один раз пароль не должен задержаться после ухода со страницы
    view.innerHTML = '<div class="page-head"><a class="back-link" href="#profile">← Профиль</a><h1 class="page-title">Пользователи</h1></div><p class="muted">Загрузка…</p>';
    let { users, serverTime } = await api('GET', '/api/admin/users');
    // часы сервера и устройства могут расходиться: считаем «сейчас» по серверу
    let nowMs = serverTime + 0;
    USERS.now = nowMs;
    const nowCount = () => users.filter((u) => u.readingNow).length;
    view.innerHTML = `<div class="page-head"><a class="back-link" href="#profile">← Профиль</a>
        <h1 class="page-title">Пользователи</h1>
        <p class="page-sub">Кто зарегистрирован, что читает прямо сейчас и что читал раньше</p></div>
      <div class="stats four" id="u-stats"></div>
      <p class="muted small u-week" id="u-week"></p>
      <div class="u-tools">
        <input type="search" id="u-q" placeholder="Найти по нику" autocomplete="off" value="${esc(USERS.q)}" aria-label="Найти по нику">
        <button type="button" class="btn ghost small" id="u-refresh">Обновить</button>
      </div>
      <div class="u-list-wrap" id="u-wrap"></div>`;
    const paintStats = () => {
      const startToday = new Date(nowMs); startToday.setHours(0, 0, 0, 0);
      const online = users.filter((u) => u.lastSeenAt && nowMs - u.lastSeenAt < ONLINE_MS).length;
      const today = users.filter((u) => u.lastSeenAt >= startToday.getTime()).length;
      const week = users.filter((u) => u.lastSeenAt >= nowMs - 7 * 86400000).length;
      $('#u-stats').innerHTML = `
        <div class="stat"><b>${users.length}</b><span>зарегистрировано</span></div>
        <div class="stat"><b>${online}</b><span>в сети сейчас</span></div>
        <div class="stat"><b>${nowCount()}</b><span>читают сейчас</span></div>
        <div class="stat"><b>${today}</b><span>заходили сегодня</span></div>`;
      $('#u-week').innerHTML = `За 7 дней заходили: <b>${week}</b> из ${users.length}`;
    };
    const paint = () => {
      const q = USERS.q.trim().toLowerCase();
      const shown = users.filter((u) => !q || u.nick.toLowerCase().includes(q));
      $('#u-wrap').innerHTML = shown.length ? shown.map((u) => userCardHtml(u, nowMs)).join('')
        : '<div class="empty">Никого не найдено.</div>';
      paintStats();
      $('#ue-input')?.focus({ preventScroll: true });
    };
    const reload = async () => {
      const r = await api('GET', '/api/admin/users');
      users = r.users; nowMs = r.serverTime; USERS.now = nowMs;
      paint();
    };
    // открытие/закрытие карточек и вложенной истории запоминаем
    $('#u-wrap').addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.matches('.u-card')) {
        const id = Number(d.dataset.uid);
        if (d.open) USERS.open.add(id); else USERS.open.delete(id);
      } else if (d.matches('.u-hist')) {
        const id = Number(d.dataset.hist);
        if (d.open) USERS.hist.add(id); else USERS.hist.delete(id);
      }
    }, true);
    $('#u-wrap').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-uact]');
      if (!btn) return;
      const card = btn.closest('.u-card');
      const u = users.find((x) => x.id === Number(card?.dataset.uid));
      if (!u) return;
      const act = btn.dataset.uact;
      if (act === 'nick') { USERS.edit = { id: u.id, kind: 'nick' }; USERS.notice = null; paint(); return; }
      if (act === 'pass') { USERS.edit = { id: u.id, kind: 'pass', value: genPassword() }; USERS.notice = null; paint(); return; }
      if (act === 'regen') { USERS.edit.value = genPassword(); paint(); return; }
      if (act === 'cancel') { USERS.edit = null; paint(); return; }
      if (act === 'copy') {
        try { await navigator.clipboard.writeText(btn.dataset.pw); toast('Пароль скопирован'); } catch { toast('Не удалось скопировать — выделите пароль вручную', true); }
        return;
      }
      if (act === 'save') {
        const input = $('#ue-input');
        const value = input.value.trim();
        const err = $('#ue-err');
        err.textContent = '';
        btn.disabled = true;
        try {
          if (USERS.edit.kind === 'nick') {
            if (value === u.nick) { USERS.edit = null; paint(); return; }
            await api('POST', `/api/admin/users/${u.id}/nick`, { nick: value });
            USERS.notice = { id: u.id, text: `Логин изменён: теперь «${value}». Скажите человеку новый логин — пароль прежний.` };
            if (u.isMe) state.me.nick = value;
          } else {
            await api('POST', `/api/admin/users/${u.id}/password`, { password: input.value });
            USERS.notice = { id: u.id, text: `Пароль для «${u.nick}» изменён. Передайте его человеку — потом он сможет сменить его сам в профиле.`, password: input.value };
          }
          USERS.edit = null;
          await reload();
        } catch (er) {
          err.textContent = er.message;
          btn.disabled = false;
        }
        return;
      }
      if (act === 'delete') {
        if (!confirm(`Удалить аккаунт «${u.nick}»?\n\nВместе с ним удалятся закладки, выделения, прогресс чтения и список «Хочу прочитать». Это нельзя отменить.`)) return;
        try {
          await api('DELETE', `/api/admin/users/${u.id}`);
          USERS.open.delete(u.id);
          toast(`Аккаунт «${u.nick}» удалён`);
          await reload();
        } catch (er) { toast(er.message, true); }
      }
    });
    $('#u-q').oninput = (e) => { USERS.q = e.target.value; paint(); };
    $('#u-refresh').onclick = () => reload().then(() => toast('Обновлено')).catch((e) => toast(e.message, true));
    paint();
    // «читает сейчас» обновляется само, пока открыта эта страница и не идёт редактирование
    USERS.timer = setInterval(() => {
      if (state.route !== 'users' || !$('#u-wrap')) { clearInterval(USERS.timer); return; }
      if (USERS.edit || document.hidden) return;
      reload().catch(() => {});
    }, 30000);
  }

  // «Мои книги»: «Хочу прочитать» (то, что добавлено кнопкой ♡), «Читаю» и «Прочитано»
  const MYBOOKS = { tab: 'reading' };
  async function renderFavorites() {
    if (!state.me) {
      view.innerHTML = `<div class="page-head"><h1 class="page-title">Мои книги</h1></div>
        <div class="empty">Войдите, чтобы собрать свои книги: «Хочу прочитать», «Читаю» и «Прочитано».<br>
        <button type="button" class="btn primary" id="fav-login">Войти</button></div>`;
      $('#fav-login').onclick = () => openAuth('login', render);
      return;
    }
    const [fav, prog] = await Promise.all([api('GET', '/api/favorites'), api('GET', '/api/progress')]);
    const all = prog.items.map((i) => i.book);
    const lists = {
      reading: all.filter((b) => !isFinished(b)),
      want: fav.books,
      done: all.filter(isFinished),
    };
    const labels = { reading: 'Читаю', want: 'Хочу прочитать', done: 'Прочитано' };
    const empty = {
      want: 'В списке «Хочу прочитать» пока пусто. Нажмите ♡ на обложке книги в библиотеке — она появится здесь.',
      reading: 'Вы пока ничего не читаете. Откройте любую книгу — она появится здесь.',
      done: 'Прочитанных книг пока нет.',
    };
    const tab = lists[MYBOOKS.tab] ? MYBOOKS.tab : 'reading';
    const books = lists[tab];
    view.innerHTML = `<div class="page-head"><h1 class="page-title">Мои книги</h1></div>
      <div class="tabs mybooks-tabs" role="tablist">${Object.keys(labels).map((id) => `
        <button type="button" role="tab" class="tab ${id === tab ? 'active' : ''}" aria-selected="${id === tab}" data-mytab="${id}">${labels[id]} · ${lists[id].length}</button>`).join('')}</div>
      ${books.length
        ? `<div class="book-rows" id="fav-grid">${books.map(rowHtml).join('')}</div>`
        : `<div class="empty">${empty[tab]}<br>
           <a class="btn ghost" href="#catalog">Перейти в библиотеку</a></div>`}`;
    $$('[data-mytab]', view).forEach((t) => (t.onclick = () => { MYBOOKS.tab = t.dataset.mytab; renderFavorites(); }));
    initShelves();
  }

  /* ================= Верхнее меню на компьютере: не наезжает на название и кнопки справа ================= */
  {
    const tabbar = $('.tabbar');
    const brand = $('.brand');
    const actions = $('.top-actions');
    const placeTabbar = () => {
      if (!tabbar || !brand || !actions) return;
      if (window.innerWidth < 900) { tabbar.style.left = ''; tabbar.style.transform = ''; return; } // телефон и планшет: панель внизу
      tabbar.style.transform = 'none';
      tabbar.style.left = '0px'; // сначала измеряем естественную ширину
      const w = tabbar.offsetWidth;
      const minLeft = brand.getBoundingClientRect().right + 16;
      const maxLeft = actions.getBoundingClientRect().left - 16 - w;
      let left = window.innerWidth / 2 - w / 2; // по умолчанию — по центру окна
      left = Math.min(left, maxLeft);
      left = Math.max(left, minLeft);
      tabbar.style.left = `${Math.round(left)}px`;
    };
    window.addEventListener('resize', placeTabbar);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(placeTabbar); // меняется ширина названия (шрифты), кнопок справа (огонёк, «скачанные»)
      [brand, actions, tabbar].forEach((el) => el && ro.observe(el));
    }
    document.fonts?.ready.then(placeTabbar);
    placeTabbar();
  }

  /* ================= Делегирование кликов ================= */
  document.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      // повторный клик по языку снимает фильтр
      const same = chip.dataset.chip === 'lang' && state.lang === chip.dataset.val;
      state[chip.dataset.chip] = same ? '' : chip.dataset.val;
      drawChips();
      loadCatalogGrid();
      return;
    }
    const pub = e.target.closest('[data-pub]');
    if (pub) {
      window.scrollTo(0, 0);
      pickPublisher(pub.dataset.pub);
      return;
    }
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.preventDefault();
      toggleFav(Number(fav.dataset.fav));
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      openBook(Number(open.dataset.open));
    }
  });

  function openBook(id) {
    if (!state.me) {
      openAuth('login', () => openReader(id));
      return;
    }
    openReader(id);
  }

  async function toggleFav(id) {
    if (!state.me) {
      openAuth('login', () => toggleFav(id));
      return;
    }
    const btns = $$(`[data-fav="${id}"]`);
    const on = !btns[0]?.classList.contains('on');
    try {
      await api(on ? 'PUT' : 'DELETE', `/api/favorites/${id}`);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    btns.forEach((b) => {
      b.classList.toggle('on', on);
      b.textContent = on ? '♥' : '♡';
      b.setAttribute('aria-pressed', on);
      b.setAttribute('aria-label', on ? 'Убрать из «Хочу прочитать»' : 'Хочу прочитать');
    });
    if (state.route === 'favorites' && !on) renderFavorites();
    toast(on ? 'Добавлено в «Хочу прочитать»' : 'Убрано из «Хочу прочитать»');
  }

  /* ================= Модальные окна ================= */
  function openModal(id) {
    const m = $('#' + id);
    m.hidden = false;
    document.body.classList.add('no-scroll');
    return m;
  }
  function closeModal(m) {
    m.hidden = true;
    if (!$$('.modal').some((x) => !x.hidden) && $('#reader').hidden) document.body.classList.remove('no-scroll');
  }
  $$('.modal').forEach((m) => {
    $$('[data-close]', m).forEach((b) => (b.onclick = () => closeModal(m)));
    m.addEventListener('mousedown', (e) => {
      if (e.target === m) closeModal(m);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = $$('.modal').filter((m) => !m.hidden);
      if (open.length) return closeModal(open[open.length - 1]);
      if (!$('#reader').hidden && !document.fullscreenElement && !readerEscape()) closeReader();
    }
  });

  /* ================= Вход и регистрация ================= */
  let authMode = 'login';
  const authAva = regAvatar('auth', $('#auth-form'), $('#auth-error'));
  function setAuthMode(mode) {
    authMode = mode;
    $$('#m-auth .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
    $('#auth-title').textContent = mode === 'login' ? 'Вход в аккаунт' : 'Создать аккаунт';
    $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
    $('#auth-form [name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    authAva.show(mode === 'register');
    $('#auth-error').textContent = '';
  }

  function openAuth(mode = 'login', then = null) {
    state.afterLogin = then;
    setAuthMode(mode);
    openModal('m-auth');
    setTimeout(() => $('#auth-form [name=nick]').focus(), 30);
  }

  $$('#m-auth .tab').forEach((t) => (t.onclick = () => setAuthMode(t.dataset.tab)));

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = $('#auth-submit');
    $('#auth-error').textContent = '';
    btn.disabled = true;
    try {
      const { user } = await api('POST', authMode === 'login' ? '/api/login' : '/api/register', {
        nick: form.nick.value.trim(),
        password: form.password.value,
      });
      let avaFailed = false;
      if (authMode === 'register' && authAva.has()) {
        try { user.avatarVer = await authAva.upload(); } catch { avaFailed = true; }
      }
      state.me = user;
      syncStreak();
      form.reset();
      authAva.reset();
      closeModal($('#m-auth'));
      toast(avaFailed ? 'Аккаунт создан, но фото не загрузилось. Добавьте его в профиле.'
        : authMode === 'login' ? `С возвращением, ${user.nick}!` : `Добро пожаловать, ${user.nick}!`);
      const next = state.afterLogin;
      state.afterLogin = null;
      await render();
      if (next) next();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  /* ================= Профиль ================= */
  // повторное нажатие на «Издательства» возвращает к списку
  $('.tabbar [data-nav=publishers]').addEventListener('click', () => {
    if (state.route === 'publishers' && state.publisher) { state.publisher = ''; render(); }
  });

  /* ---------- Тема: светлая / тёмная / розовая ---------- */
  const THEME_COLOR = { light: '#f4efe4', dark: '#151a17', pink: '#fbeff3', blue: '#eef3fb', green: '#eef5ec' };
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  const themeBtn = $('#theme-btn');
  const themePop = $('#theme-pop');
  const curTheme = () => document.documentElement.dataset.theme || (sysDark.matches ? 'dark' : 'light');
  function paintTheme() {
    const t = curTheme();
    $$('[data-theme-set]', themePop).forEach((b) => {
      const on = b.dataset.themeSet === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    const m = document.querySelector('meta[name=theme-color]');
    if (m) m.content = THEME_COLOR[t];
  }
  const closeThemePop = () => { themePop.hidden = true; themeBtn.setAttribute('aria-expanded', 'false'); };
  themeBtn.onclick = (e) => {
    e.stopPropagation();
    themePop.hidden = !themePop.hidden;
    themeBtn.setAttribute('aria-expanded', String(!themePop.hidden));
  };
  themePop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-set]');
    if (!b) return;
    document.documentElement.dataset.theme = b.dataset.themeSet;
    try { localStorage.setItem('theme', b.dataset.themeSet); } catch { /* ok */ }
    paintTheme();
    closeThemePop();
  });
  document.addEventListener('click', (e) => { if (!themePop.hidden && !e.target.closest('.theme-wrap')) closeThemePop(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !themePop.hidden) closeThemePop();
    if (e.key === 'Enter' && e.target.classList?.contains('cr-card')) openBook(Number(e.target.dataset.open));
  });
  sysDark.addEventListener?.('change', paintTheme);
  paintTheme();

  $('#nav-profile').onclick = () => {
    if (!state.me) openAuth('login');
    else if (location.hash === '#profile') render();
    else location.hash = '#profile';
  };

  async function renderProfile() {
    const body = view;
    body.innerHTML = '<div class="page-head"><h1 class="page-title">Профиль</h1></div><p class="muted">Загрузка…</p>';
    let stats = { reading: 0, finished: 0, favorites: 0 };
    let items = [];
    try {
      [stats, { items }] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/progress')]);
    } catch (e) {
      body.innerHTML = `<div class="page-head"><h1 class="page-title">Профиль</h1></div><p class="form-error">${esc(e.message)}</p>`;
      return;
    }
    const cont = items.map((i) => i.book).filter((b) => !isFinished(b)).slice(0, 4);
    const since = stats.since
      ? new Date(stats.since).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    const hhmm = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    body.innerHTML = `
      <div class="page-head"><h1 class="page-title">Профиль</h1></div>
      <div class="profile-page">
      <div class="profile-head">
        ${avatarHtml(state.me)}
        <div><b>${esc(state.me.nick)}</b>${state.me.isAdmin ? '<span class="badge">админ</span>' : ''}
          ${state.me.phone ? `<div class="muted small" dir="ltr">${esc(state.me.phone)}</div>` : ''}
          ${since ? `<div class="muted small">С нами с ${esc(since)} г.</div>` : ''}
          <div class="muted small">Прогресс чтения хранится в аккаунте</div></div>
      </div>
      <div class="profile-actions top">
        <button type="button" class="btn ghost" id="p-edit">Редактировать профиль</button>
        <button type="button" class="btn ghost" id="p-stats">Статистика</button>
        <button type="button" class="btn ghost" id="p-logout">Выйти</button>
      </div>
      <div class="sync-line">✓ Прогресс и «Хочу прочитать» синхронизированы · ${hhmm}</div>
      <div class="streak-line">${FLAME_SVG}<span>${STREAK.streak > 0
        ? `Серия чтения: <b>${STREAK.streak}</b> ${daysWord(STREAK.streak)}${STREAK.best > STREAK.streak ? ` · рекорд <b>${STREAK.best}</b>` : ''}${STREAK.today ? '' : '. Прочитайте сегодня страницу, чтобы продолжить'}`
        : 'Прочитайте сегодня хотя бы страницу — начнётся серия'}</span></div>
      <div class="stats">
        <div class="stat"><b>${stats.reading}</b><span>читаю</span></div>
        <div class="stat"><b>${stats.finished}</b><span>прочитано</span></div>
        <div class="stat"><b>${stats.favorites}</b><span>хочу прочитать</span></div>
      </div>
      <button type="button" class="btn ghost wide p-notes" id="p-notes">Мои закладки <b>${stats.bookmarks || 0}</b> и выделения <b>${stats.highlights || 0}</b></button>
      <div class="p-social">
        <h4>Наши соцсети</h4>
        <div class="p-social-links">
          <a class="soc-btn" href="${SOCIAL_LINKS.telegram}" target="_blank" rel="noopener noreferrer" aria-label="Telegram" title="Telegram">${SOC_TG_SVG}</a>
          <a class="soc-btn" href="${SOCIAL_LINKS.instagram}" target="_blank" rel="noopener noreferrer" aria-label="Instagram" title="Instagram">${SOC_IG_SVG}</a>
        </div>
      </div>
      ${cont.length ? `<h4>Продолжить чтение</h4><div class="cont">${cont.map((b) => `
        <button type="button" class="cont-item" data-continue="${b.id}">${thumbHtml(b)}
          <span class="txt"><b dir="auto">${esc(b.title)}</b>
          <span class="sub">${b.pages > 0 ? `стр. ${b.progress.page} из ${b.pages}` : `стр. ${b.progress.page}`}</span></span>
        </button>`).join('')}</div>` : ''}
      ${state.me.isAdmin ? '<div class="profile-actions"><button type="button" class="btn primary" id="p-manage">Управление библиотекой</button><a class="btn primary" href="#users">Пользователи</a></div>' : ''}
      </div>`;

    $$('[data-continue]', body).forEach((b) => (b.onclick = () => {
      openReader(Number(b.dataset.continue));
    }));
    $('#p-notes').onclick = () => openNotes();
    const pm = $('#p-manage');
    if (pm) pm.onclick = () => openManage();
    $('#p-edit').onclick = () => openEditProfile();
    $('#p-stats').onclick = () => openStats();
    $('#p-logout').onclick = async () => {
      try { await api('POST', '/api/logout'); } catch { /* всё равно выходим */ }
      state.me = null;
      Object.assign(STREAK, { streak: 0, best: 0, today: false });
      try { navigator.serviceWorker?.controller?.postMessage({ type: 'clear-user' }); } catch { /* ok */ }
      toast('Вы вышли из аккаунта');
      history.replaceState(null, '', '#home');
      render();
    };
  }

  /* ================= Статистика чтения: страницы по дням, неделям и месяцам ================= */
  // Режимы: week — неделя с понедельника, month — календарный месяц.
  // off — сдвиг от текущего периода: 0 — текущий, -1 — предыдущий и т.д.
  const STATS = { days: {}, mode: 'week', sel: 0, end: 0, pick: null, pts: [], W: 340 }; // pick — выбранный день («2026-10-23»)
  const ST_WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const ST_MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const ST_MON_CAP = ['ЯНВ.', 'ФЕВР.', 'МАРТ', 'АПР.', 'МАЙ', 'ИЮНЬ', 'ИЮЛЬ', 'АВГ.', 'СЕНТ.', 'ОКТ.', 'НОЯБ.', 'ДЕК.'];
  const ST_MON_SHORT = ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
  const ST_MON_3 = ['ЯНВ', 'ФЕВ', 'МАР', 'АПР', 'МАЙ', 'ИЮН', 'ИЮЛ', 'АВГ', 'СЕН', 'ОКТ', 'НОЯ', 'ДЕК'];
  const ST_N = 10; // сколько точек на графике
  const ST_MAX = { week: 52, month: 12 }; // насколько далеко назад можно листать
  const ST_MODES = [['week', 'Н', 'Неделя'], ['month', 'М', 'Месяц']];
  const ST_REL = { week: 'Эта неделя', month: 'Этот месяц' };
  const ST_TOTAL_CAP = { week: 'страниц за неделю', month: 'страниц за месяц' };
  const ST_AVG_CAP = { week: 'в среднем за день', month: 'в среднем за день' };
  const ST_PREV = { week: 'на прошлой неделе', month: 'в прошлом месяце' };
  const ST_NOTE = {
    week: 'Нажмите на день, чтобы увидеть его страницы. Недели листаются стрелками, свайпом или нажатием на график.',
    month: 'Нажмите на день, чтобы увидеть его страницы. Месяцы листаются стрелками, свайпом или нажатием на график.',
  };
  const stPad = (n) => String(n).padStart(2, '0');
  const stKey = (d) => `${d.getFullYear()}-${stPad(d.getMonth() + 1)}-${stPad(d.getDate())}`;
  const stAdd = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const stMonday = (d) => stAdd(d, -((d.getDay() + 6) % 7));
  const stNum = (n) => Number(n).toLocaleString('ru-RU');
  const stToday = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };

  // первый день, в который есть чтение: раньше этого дня среднее не считаем
  function stFirstKey() {
    const keys = Object.keys(STATS.days).filter((k) => STATS.days[k] > 0).sort();
    return keys[0] || stKey(stToday());
  }

  // Один период (неделя или месяц): дни, сумма страниц и среднее в день.
  function stPeriod(mode, off) {
    const today = stToday();
    const todayKey = stKey(today);
    const first = stFirstKey();
    let start;
    let count;
    if (mode === 'week') { start = stAdd(stMonday(today), off * 7); count = 7; }
    else {
      start = new Date(today.getFullYear(), today.getMonth() + off, 1);
      count = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    }
    const days = [];
    for (let i = 0; i < count; i++) {
      const d = stAdd(start, i);
      const k = stKey(d);
      days.push({ d, k, v: STATS.days[k] || 0, future: k > todayKey, today: k === todayKey, before: k < first });
    }
    const total = days.reduce((s, x) => s + x.v, 0);
    // среднее за день: только дни, которые уже прошли и не раньше первого чтения; сегодняшний день без чтения ещё не закончился
    let counted = days.filter((x) => !x.future && !x.before);
    if (off === 0 && counted.length > 1) {
      const last = counted[counted.length - 1];
      if (last.today && last.v === 0) counted = counted.slice(0, -1);
    }
    const avg = counted.length ? Math.round(total / counted.length) : 0;
    const hasData = days[days.length - 1].k >= first; // период не целиком раньше первого чтения
    return { mode, off, start, days, total, avg, hasData };
  }

  function stRange(start) {
    const e = stAdd(start, 6);
    const yr = start.getFullYear() !== new Date().getFullYear() ? ` ${e.getFullYear()}` : '';
    return start.getMonth() === e.getMonth()
      ? `${start.getDate()}–${e.getDate()} ${ST_MON[e.getMonth()]}${yr}`
      : `${start.getDate()} ${ST_MON[start.getMonth()]} – ${e.getDate()} ${ST_MON[e.getMonth()]}${yr}`;
  }

  // подпись периода: неделя — даты, месяц — «окт. 2026 г.»
  function stLabel(p) {
    const s = p.start;
    return p.mode === 'month' ? `${ST_MON_SHORT[s.getMonth()]} ${s.getFullYear()} г.` : stRange(s);
  }

  function stSmooth(pts, top, bottom) {
    if (pts.length < 2) return '';
    const cl = (y) => Math.min(bottom, Math.max(top, y));
    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = cl(p1.y + (p2.y - p0.y) / 6);
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = cl(p2.y - (p3.y - p1.y) / 6);
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
  }

  const ST_ARROW_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 9v8H9"/></svg>';
  const ST_ARROW_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';

  function stChartSvg() {
    const mode = STATS.mode;
    const W = 340;
    const H = 150;
    const padX = 22;
    const top = 34;
    const bottom = H - 16;
    const per = [];
    for (let i = 0; i < ST_N; i++) per.push(stPeriod(mode, STATS.end - (ST_N - 1) + i));
    const maxT = Math.max(1, ...per.map((w) => w.total));
    const mean = per.reduce((s, w) => s + w.total, 0) / per.length;
    const x = (i) => padX + (i * (W - padX * 2)) / (ST_N - 1);
    const y = (v) => bottom - (v / maxT) * (bottom - top);
    const pts = per.map((w, i) => ({ x: x(i), y: y(w.total), w }));
    STATS.W = W;
    STATS.pts = pts.map((p) => ({ x: p.x, off: p.w.off })); // для выбора периода нажатием на график
    const line = stSmooth(pts, top, bottom);
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${bottom} L${pts[0].x.toFixed(1)},${bottom} Z`;
    let labels = '';
    if (mode === 'month') {
      // у каждой точки — месяц, выбранный на «таблетке»
      pts.forEach((p) => {
        const on = p.w.off === STATS.sel;
        if (on) labels += `<rect class="st-pill" x="${(p.x - 16).toFixed(1)}" y="3" width="32" height="18" rx="9"/>`;
        labels += `<text class="st-mon${on ? ' on' : ''}" x="${p.x.toFixed(1)}" y="16" text-anchor="middle">${ST_MON_3[p.w.start.getMonth()]}</text>`;
      });
    } else {
      let prevMon = -1;
      pts.forEach((p) => {
        const m = p.w.start.getMonth();
        if (m !== prevMon) labels += `<text class="st-mon" x="${p.x.toFixed(1)}" y="16" text-anchor="${p.x < 40 ? 'start' : 'middle'}">${ST_MON_CAP[m]}</text>`;
        prevMon = m;
      });
    }
    const grid = pts.map((p) => `<line class="st-grid" x1="${p.x.toFixed(1)}" y1="26" x2="${p.x.toFixed(1)}" y2="${H}"/>`).join('');
    const dots = pts.map((p) => {
      const on = p.w.off === STATS.sel;
      return on
        ? `<circle class="st-dot-ring" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9"/><circle class="st-dot-core" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5"/>`
        : `<circle class="st-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5"/>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="st-svg" aria-label="Страницы по периодам">
      <defs><linearGradient id="st-fill" x1="0" y1="0" x2="0" y2="1"><stop class="st-s0" offset="0"/><stop class="st-s1" offset="1"/></linearGradient></defs>
      ${grid}${labels}
      <path d="${area}" fill="url(#st-fill)"/>
      <line class="st-mean" x1="${padX}" y1="${y(mean).toFixed(1)}" x2="${W - padX}" y2="${y(mean).toFixed(1)}"/>
      <path class="st-line" d="${line}"/>
      ${dots}
    </svg>`;
  }

  // «Пт, 23 окт» (с годом, если не этот)
  function stDayText(d) {
    const yr = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
    return `${ST_WD[(d.getDay() + 6) % 7]}, ${d.getDate()} ${ST_MON[d.getMonth()]}${yr}`;
  }

  // панель выбранного дня: показывается прямо в окне, под столбиками или календарём
  function stPickHtml(p) {
    const d = STATS.pick ? p.days.find((x) => x.k === STATS.pick) : null;
    if (!d || d.future) return '';
    const maxV = Math.max(0, ...p.days.map((x) => x.v));
    const star = d.v > 0 && d.v === maxV ? ` <span class="st-pick-best" title="Больше всего за ${p.mode === 'month' ? 'месяц' : 'неделю'}">★</span>` : '';
    return `<div class="st-pick-day">${esc(stDayText(d.d))}${d.today ? ' <span class="st-dotsep">•</span> сегодня' : ''}</div>
      <div class="st-pick-val"><b>${stNum(d.v)}</b> ${d.v === 0 ? 'страниц — в этот день не читали' : 'стр. прочитано'}${star}</div>`;
  }

  // столбцы Пн–Вс
  function stBarsHtml(w) {
    const maxV = Math.max(...w.days.map((d) => d.v));
    const best = maxV > 0 ? w.days.findIndex((d) => d.v === maxV) : -1;
    return w.days.map((d, i) => {
      const pct = d.v > 0 ? Math.max(14, Math.round((d.v / maxV) * 100)) : 0;
      const cls = d.future ? 'future' : d.v === 0 ? 'zero' : '';
      const on = d.k === STATS.pick;
      const tag = d.future ? 'div' : 'button'; // будущие дни не нажимаются
      const attrs = d.future ? '' : ` type="button" data-k="${d.k}" aria-pressed="${on}" aria-label="${stDayText(d.d)}: ${stNum(d.v)} стр."`;
      return `<${tag} class="st-day${d.today ? ' today' : ''}${on ? ' sel' : ''}"${attrs}>
        <div class="st-wd">${ST_WD[i]}</div>
        <div class="st-val">${d.future ? '' : stNum(d.v)}</div>
        <div class="st-col"><div class="st-track ${cls}">${d.future ? '' : `<div class="st-fill" style="height:${pct}%"></div>`}${i === best ? '<span class="st-star" title="Больше всего за неделю">★</span>' : ''}</div></div>
      </${tag}>`;
    }).join('');
  }

  // календарь месяца: кружки по дням, насыщенность — сколько прочитано, звезда — лучший день, кольцо — сегодня
  function stMonthHtml(p) {
    const lead = (p.start.getDay() + 6) % 7;
    const maxV = Math.max(0, ...p.days.map((d) => d.v));
    const best = maxV > 0 ? p.days.findIndex((d) => d.v === maxV) : -1;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<i class="st-pad"></i>');
    p.days.forEach((d, i) => {
      if (d.future) { cells.push('<i class="st-pad"></i>'); return; }
      const a = d.v > 0 ? 0.3 + 0.7 * (d.v / maxV) : 0;
      const on = d.k === STATS.pick;
      const cls = `st-cell${d.v > 0 ? ` on${a >= 0.62 ? ' hi' : ''}` : ' zero'}${d.today ? ' today' : ''}${on ? ' sel' : ''}`;
      cells.push(`<button type="button" class="${cls}" style="--a:${a.toFixed(2)}" data-k="${d.k}" aria-pressed="${on}" aria-label="${stDayText(d.d)}: ${stNum(d.v)} стр."><span>${d.d.getDate()}</span>${i === best ? '<b class="st-cellstar">★</b>' : ''}</button>`);
    });
    while (cells.length % 7) cells.push('<i class="st-pad"></i>');
    const head = ST_WD.map((w) => `<div class="st-wd">${w}</div>`).join('');
    return `<div class="st-mhead">${head}</div><div class="st-mgrid">${cells.join('')}</div>`;
  }

  function paintStats() {
    const card = $('#st-card');
    if (!card) return;
    const mode = STATS.mode;
    const p = stPeriod(mode, STATS.sel);
    // стрелка: среднее за день сравниваем с прошлым периодом. Больше — зелёная вверх, меньше — красная вниз
    let cmp = null;
    const prev = stPeriod(mode, STATS.sel - 1);
    if (prev.hasData && p.avg !== prev.avg) cmp = [p.avg > prev.avg, `чем ${ST_PREV[mode]} (${stNum(prev.avg)} стр. в день)`];
    const trend = cmp
      ? `<i class="st-trend ${cmp[0] ? 'up' : 'down'}" title="${cmp[0] ? 'Больше' : 'Меньше'}, ${cmp[1]}">${cmp[0] ? ST_ARROW_UP : ST_ARROW_DOWN}</i>`
      : '';
    const rel = STATS.sel === 0 ? ST_REL[mode] : '';
    const hasAny = Object.values(STATS.days).some((v) => v > 0);
    $('#st-seg').innerHTML = ST_MODES.map(([m, ch, name]) =>
      `<button type="button" class="tab${m === mode ? ' active' : ''}" role="tab" aria-selected="${m === mode}" aria-label="${name}" data-mode="${m}">${ch}</button>`).join('');
    $('#st-head').innerHTML = `
      <div class="st-left">
        <div class="st-weeknav">
          <button type="button" class="st-nav" id="st-prev" aria-label="Назад"${STATS.sel <= -ST_MAX[mode] ? ' disabled' : ''}>‹</button>
          <span class="st-range">${esc(stLabel(p))}${rel ? ` <span class="st-dotsep">•</span> ${rel}` : ''}</span>
          <button type="button" class="st-nav" id="st-next" aria-label="Вперёд"${STATS.sel >= 0 ? ' disabled' : ''}>›</button>
        </div>
        <div class="st-total">${stNum(p.total)}</div>
        <div class="st-cap">${ST_TOTAL_CAP[mode]}</div>
      </div>
      <div class="st-right">
        <div class="st-avg"><span>⌀ ${stNum(p.avg)}</span>${trend}</div>
        <div class="st-cap">${ST_AVG_CAP[mode]}</div>
      </div>`;
    $('#st-days').className = `st-days${mode === 'month' ? ' month' : ''}`;
    $('#st-days').innerHTML = mode === 'month' ? stMonthHtml(p) : stBarsHtml(p);
    const pickHtml = stPickHtml(p);
    $('#st-pick').innerHTML = pickHtml;
    $('#st-pick').hidden = !pickHtml;
    $('#st-chart').innerHTML = stChartSvg();
    $('#st-hint').hidden = hasAny;
    $('#st-note').textContent = ST_NOTE[mode];

    $('#st-prev').onclick = () => stGo(STATS.sel - 1);
    $('#st-next').onclick = () => stGo(STATS.sel + 1);
  }

  // нажатие в любом месте графика выбирает ближайший по горизонтали период — попадать точно в кружок не нужно
  function stPick(clientX) {
    const svg = $('#st-chart .st-svg');
    if (!svg || !STATS.pts || !STATS.pts.length) return;
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const vx = ((clientX - r.left) / r.width) * STATS.W;
    let best = STATS.pts[0];
    for (const p of STATS.pts) if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p;
    stGo(best.off);
  }

  // выбранный период должен быть виден на графике
  function stFit() {
    const lo = STATS.end - (ST_N - 1);
    if (STATS.sel > STATS.end) STATS.end = STATS.sel;
    else if (STATS.sel < lo) STATS.end = STATS.sel + (ST_N - 1);
    STATS.end = Math.min(0, STATS.end);
  }

  function stGo(off) {
    off = Math.max(-ST_MAX[STATS.mode], Math.min(0, off));
    if (off === STATS.sel) return;
    STATS.sel = off;
    STATS.pick = null; // новый период — выбранный день сбрасывается
    stFit();
    paintStats();
  }

  // нажатие на день: показать его итог в окне; повторное нажатие на тот же день снимает выбор
  function stPickDay(key) {
    const p = stPeriod(STATS.mode, STATS.sel);
    const d = p.days.find((x) => x.k === key);
    if (!d || d.future) return;
    STATS.pick = STATS.pick === key ? null : key;
    paintStats();
  }

  // переключатель Н / М: открывается текущая неделя или текущий месяц
  function stSetMode(mode) {
    if (!ST_MAX[mode]) return;
    if (mode === STATS.mode) return;
    STATS.mode = mode;
    STATS.sel = 0;
    STATS.end = 0;
    STATS.pick = null;
    paintStats();
  }

  // окно «Статистика» открывается из профиля, как «Редактировать профиль»
  async function openStats() {
    const body = $('#stats-body');
    body.innerHTML = '<p class="muted">Загрузка…</p>';
    openModal('m-stats');
    try {
      const d = await api('GET', '/api/read-stats');
      STATS.days = d.days || {};
    } catch (e) {
      body.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
      return;
    }
    STATS.mode = 'week';
    STATS.sel = 0;
    STATS.end = 0;
    STATS.pick = null;
    body.innerHTML = `
      <div class="tabs st-seg" id="st-seg" role="tablist" aria-label="Период"></div>
      <div class="st-card" id="st-card">
        <div class="st-top" id="st-head"></div>
        <div class="st-days" id="st-days"></div>
        <div class="st-pick" id="st-pick" hidden aria-live="polite"></div>
        <div class="st-chartbox" id="st-chart"></div>
      </div>
      <p class="muted small st-note" id="st-hint" hidden>Здесь появятся страницы, которые вы прочитаете. Статистика ведётся с момента её появления на сайте.</p>
      <p class="muted small st-note" id="st-note"></p>
      <p class="muted small st-note">Страница считается один раз в день, а прыжок по ползунку чтением не считается.</p>`;
    paintStats();
    const card = $('#st-card');
    // Н / М
    $('#st-seg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) stSetMode(b.dataset.mode);
    });
    // нажатие на день (столбик недели или кружок месяца) — итог за этот день показывается тут же
    $('#st-days').addEventListener('click', (e) => {
      if (Date.now() - (STATS.swiped || 0) < 400) return; // это был свайп, а не нажатие
      const b = e.target.closest('[data-k]');
      if (b) stPickDay(b.dataset.k);
    });
    // нажатие на график — выбрать период
    $('#st-chart').addEventListener('click', (e) => {
      if (Date.now() - (STATS.swiped || 0) < 400) return; // это был свайп, а не нажатие
      stPick(e.clientX);
    });
    // свайп влево/вправо по карточке — переход между периодами
    let sx = null;
    card.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    card.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (Math.abs(dx) > 60) {
        STATS.swiped = Date.now();
        stGo(STATS.sel + (dx > 0 ? -1 : 1));
      }
    }, { passive: true });
  }
  document.addEventListener('keydown', (e) => {
    const m = $('#m-stats');
    if (!m || m.hidden || !$('#st-card') || e.target.matches?.('input,textarea,select')) return;
    if (e.key === 'ArrowLeft') stGo(STATS.sel - 1);
    else if (e.key === 'ArrowRight') stGo(STATS.sel + 1);
  });

  /* ================= Редактирование профиля: аватарка, ник, пароль, номер ================= */
  // кружок с фото; пока фото грузится (или если его нет) видна первая буква ника
  function avatarHtml(u, cls = '') {
    const img = u.avatarVer ? `<img src="/api/avatar/${u.id}?v=${u.avatarVer}" alt="" draggable="false">` : '';
    return `<div class="avatar ${cls}">${esc(String(u.nick || '?')[0])}${img}</div>`;
  }
  // не загрузилось фото — убираем картинку, остаётся буква
  document.addEventListener('error', (e) => { if (e.target.matches?.('.avatar > img')) e.target.remove(); }, true);

  // фото с телефона — большое: обрезаем по центру до квадрата и сжимаем до 320×320 JPEG
  async function avatarBlob(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      src = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
        im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad')); };
        im.src = url;
      }).catch(() => null);
    }
    if (!src) throw new Error('Не удалось открыть картинку. Выберите фото в формате JPG, PNG или WebP.');
    const w = src.width || src.naturalWidth;
    const h = src.height || src.naturalHeight;
    const side = Math.min(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 320, 320);
    ctx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 320, 320);
    if (src.close) src.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) throw new Error('Не удалось подготовить фото');
    return blob;
  }

  // необязательное фото при регистрации: выбор, превью и загрузка сразу после создания аккаунта
  function regAvatarHtml(p) {
    return `<div class="pe-ava reg-ava" id="${p}-ava" hidden>
        <div class="avatar lg" id="${p}-ava-prev">?</div>
        <div class="pe-ava-btns">
          <label class="btn ghost small pe-file"><span id="${p}-ava-lbl">Добавить фото</span><input type="file" id="${p}-file" accept="image/*" hidden></label>
          <button type="button" class="btn ghost small" id="${p}-ava-clear" hidden>Убрать</button>
        </div>
        <p class="muted small pe-note">Необязательно. Фото видите только вы и администратор.</p>
      </div>`;
  }

  function regAvatar(p, form, errEl) {
    const box = $(`#${p}-ava`);
    const prev = $(`#${p}-ava-prev`);
    const file = $(`#${p}-file`);
    const clear = $(`#${p}-ava-clear`);
    const lbl = $(`#${p}-ava-lbl`);
    let blob = null;
    let url = '';
    const paint = () => {
      if (url) { URL.revokeObjectURL(url); url = ''; }
      if (blob) {
        url = URL.createObjectURL(blob);
        prev.innerHTML = `<img src="${url}" alt="" draggable="false">`;
      } else {
        prev.textContent = (form.nick.value.trim()[0] || '?');
      }
      lbl.textContent = blob ? 'Заменить фото' : 'Добавить фото';
      clear.hidden = !blob;
    };
    file.onchange = async (ev) => {
      const f = ev.target.files?.[0];
      ev.target.value = '';
      if (!f) return;
      errEl.textContent = '';
      try { blob = await avatarBlob(f); } catch (err) { errEl.textContent = err.message; return; }
      paint();
    };
    clear.onclick = () => { blob = null; paint(); };
    form.nick.addEventListener('input', () => { if (!blob) paint(); });
    paint();
    return {
      show(v) { box.hidden = !v; },
      has: () => !!blob,
      reset() { blob = null; paint(); },
      // вызывается уже после регистрации, когда есть сессия
      async upload() {
        const res = await fetch('/api/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, credentials: 'same-origin', body: blob });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Не удалось сохранить фото');
        return data.avatarVer;
      },
    };
  }

  function openEditProfile() {
    const me = state.me;
    $('#prof-body').innerHTML = `
      <div class="pe-ava" id="pe-ava"></div>
      <div class="pe-sec">
        <h4>Аккаунт</h4>
        <label class="field">Ник (он же логин для входа)<input value="${esc(me.nick)}" readonly dir="ltr"></label>
        <p class="muted small pe-note">Ник может изменить администратор библиотеки.</p>
        <div class="field">Пароль
          <div class="pe-pass"><input value="••••••••" readonly aria-label="Пароль скрыт" tabindex="-1"><button type="button" class="btn ghost small" id="pe-pass-btn">Сменить</button></div>
        </div>
        <p class="muted small pe-note">Пароль хранится в зашифрованном виде, поэтому показать его нельзя, но можно задать новый.</p>
        <form id="pe-pw-form" hidden>
          <label class="field">Текущий пароль<input name="old" type="password" autocomplete="current-password" required></label>
          <label class="field">Новый пароль (от 6 символов)<input name="new" type="password" autocomplete="new-password" minlength="6" required></label>
          <label class="field">Новый пароль ещё раз<input name="again" type="password" autocomplete="new-password" minlength="6" required></label>
          <p class="form-error" id="pe-pw-err"></p>
          <button class="btn primary" type="submit">Сохранить пароль</button>
        </form>
        <p class="ok-msg" id="pe-pw-ok"></p>
      </div>
      <form class="pe-sec" id="pe-phone-form">
        <h4>Номер телефона</h4>
        <label class="field">Телефон<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" maxlength="24" value="${esc(me.phone || '')}" dir="ltr"></label>
        <p class="muted small pe-note">Виден только вам и администратору библиотеки. Можно оставить пустым.</p>
        <p class="form-error" id="pe-phone-err"></p><p class="ok-msg" id="pe-phone-ok"></p>
        <button class="btn primary" type="submit">Сохранить номер</button>
      </form>`;

    // аватарка: выбрал фото — сразу сохраняется
    const paintAva = () => {
      $('#pe-ava').innerHTML = `${avatarHtml(state.me, 'lg')}
        <div class="pe-ava-btns">
          <label class="btn ghost small pe-file">${state.me.avatarVer ? 'Заменить фото' : 'Загрузить фото'}<input type="file" id="pe-file" accept="image/*" hidden></label>
          ${state.me.avatarVer ? '<button type="button" class="btn ghost small" id="pe-ava-del">Удалить фото</button>' : ''}
        </div><p class="form-error" id="pe-ava-err"></p>`;
      $('#pe-file').onchange = async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (!file) return;
        $('#pe-ava-err').textContent = '';
        try {
          const blob = await avatarBlob(file);
          const res = await fetch('/api/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, credentials: 'same-origin', body: blob });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Не удалось сохранить фото');
          state.me.avatarVer = data.avatarVer;
          paintAva();
          if (state.route === 'profile') renderProfile();
          toast('Фото обновлено');
        } catch (err) {
          $('#pe-ava-err').textContent = err.message === 'Failed to fetch' ? 'Нет связи с сервером' : err.message;
        }
      };
      const del = $('#pe-ava-del');
      if (del) del.onclick = async () => {
        try {
          await api('DELETE', '/api/avatar');
          state.me.avatarVer = 0;
          paintAva();
          if (state.route === 'profile') renderProfile();
          toast('Фото удалено');
        } catch (err) { $('#pe-ava-err').textContent = err.message; }
      };
    };
    paintAva();

    $('#pe-pass-btn').onclick = () => {
      const f = $('#pe-pw-form');
      f.hidden = !f.hidden;
      $('#pe-pw-ok').textContent = '';
      if (!f.hidden) f.old.focus();
    };
    $('#pe-pw-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      const err = $('#pe-pw-err');
      err.textContent = '';
      if (f.new.value !== f.again.value) { err.textContent = 'Новые пароли не совпадают'; return; }
      try {
        await api('POST', '/api/password', { oldPassword: f.old.value, newPassword: f.new.value });
        f.reset();
        f.hidden = true;
        $('#pe-pw-ok').textContent = 'Пароль изменён. На других устройствах потребуется войти заново.';
      } catch (e) {
        err.textContent = e.message;
      }
    });
    $('#pe-phone-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      $('#pe-phone-err').textContent = '';
      $('#pe-phone-ok').textContent = '';
      try {
        const res = await api('PUT', '/api/profile', { phone: f.phone.value });
        state.me.phone = res.phone;
        f.phone.value = res.phone;
        $('#pe-phone-ok').textContent = res.phone ? 'Номер сохранён.' : 'Номер удалён.';
        if (state.route === 'profile') renderProfile();
      } catch (e) {
        $('#pe-phone-err').textContent = e.message;
      }
    });
    openModal('m-profile');
  }

  /* ================= Серия чтения («огонёк») ================= */
  // День засчитывается, когда человек прочитал хотя бы страницу (не просто зашёл на сайт).
  // Огонёк появляется со 2-го дня подряд и становится крупнее каждые 30 дней.
  const FLAME_FROM = 2;
  const STREAK_STEP = 30;
  const FLAME_MAX_LEVEL = 5;
  // Ссылки на соцсети (блок «Наши соцсети» в профиле)
  const SOCIAL_LINKS = { telegram: 'https://t.me/maktabatul_ulum', instagram: 'https://www.instagram.com/maktabal_ulum/' };
  const SOC_TG_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.9 4.3 18.7 19.5c-.2 1-.9 1.3-1.7.8l-4.8-3.6-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.2 1.8 11.7c-1-.3-1-1 .2-1.5L20.3 3.1c.9-.3 1.6.2 1.6 1.2z"/></svg>';
  const SOC_IG_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>';
  const FLAME_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fo" d="M12 2s1.2 3.6-1.2 6.4C8.7 10.9 6 12.9 6 16.2 6 19.4 8.7 22 12 22s6-2.6 6-5.8c0-2.7-1.5-4.4-2.7-5.9-.4 1.2-1.1 2-2 2.4C13.9 9.4 13.4 5 12 2z"/><path class="fi" d="M12 22c-1.9 0-3.3-1.4-3.3-3.2 0-2 1.5-3 2.4-4.2.4 1 1 1.6 1.7 1.9.5-.8.7-1.5.7-2.2 1.3 1.1 1.8 2.5 1.8 4.4 0 1.8-1.4 3.3-3.3 3.3z"/></svg>';
  const STREAK = { streak: 0, best: 0, today: false, busy: false };
  const daysWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней');
  const dayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function paintStreak() {
    const btn = $('#nav-streak');
    const n = STREAK.streak;
    const show = !!state.me && n >= FLAME_FROM;
    btn.hidden = !show;
    if (!show) return;
    btn.dataset.lv = Math.min(FLAME_MAX_LEVEL, Math.floor(n / STREAK_STEP));
    btn.classList.toggle('dim', !STREAK.today);
    btn.innerHTML = `${FLAME_SVG}<b>${n}</b>`;
    btn.setAttribute('aria-label', `Серия чтения: ${n} ${daysWord(n)}`);
  }

  // read=false — только узнать серию; read=true — засчитать сегодняшний день
  async function syncStreak(read = false) {
    if (!state.me) return null;
    try {
      const s = await api('POST', '/api/streak', { day: dayKey(), read });
      Object.assign(STREAK, s);
      paintStreak();
      return s;
    } catch { return null; /* без связи серия обновится в следующий раз */ }
  }

  async function recordReading() {
    if (!state.me || reader.hidden || STREAK.today || STREAK.busy) return;
    STREAK.busy = true;
    const s = await syncStreak(true);
    STREAK.busy = false;
    if (!s?.today) return;
    if (s.streak % STREAK_STEP === 0 && s.streak > 0) toast(`🔥 ${s.streak} ${daysWord(s.streak)} подряд! Огонёк стал больше`, false, 4500);
    else if (s.streak >= FLAME_FROM) toast(`🔥 Серия чтения: ${s.streak} ${daysWord(s.streak)}`);
    else toast('Серия началась — прочитайте страницу и завтра');
  }

  $('#nav-streak').onclick = () => {
    const n = STREAK.streak;
    const left = STREAK_STEP - (n % STREAK_STEP);
    toast(`🔥 Серия чтения: ${n} ${daysWord(n)} подряд. Рекорд: ${STREAK.best}. До роста огонька: ${left} ${daysWord(left)}.`
      + (STREAK.today ? '' : ' Прочитайте сегодня хотя бы страницу, чтобы не потерять серию.'), false, 5500);
  };

  /* ================= Лучшие читатели: день, неделя, месяц ================= */
  // Рейтинг по прочитанным страницам. Администратор в нём не участвует — это решает сервер.
  const TOP = { tab: 'day', data: null };
  const TOP_TABS = [['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц']];
  const TOP_EMPTY = { day: 'Сегодня пока никто не читал.', week: 'На этой неделе пока никто не читал.', month: 'В этом месяце пока никто не читал.' };
  const TOP_MEDALS = ['🥇', '🥈', '🥉'];

  // место: в месяце 1–3 места — медальки, в остальных случаях номер
  function topRankHtml(tab, rank) {
    if (tab === 'month' && rank >= 1 && rank <= 3) return `<span class="top-medal" role="img" aria-label="${rank} место">${TOP_MEDALS[rank - 1]}</span>`;
    return String(rank);
  }

  function topRowHtml(tab, r) {
    return `<tr class="${r.me ? 'me' : ''}">
      <td class="top-rank">${topRankHtml(tab, r.rank)}</td>
      <td class="top-user"><span>${avatarHtml({ id: r.id, nick: r.nick, avatarVer: r.avatarVer }, 'sm')}<i dir="auto">${esc(r.nick)}</i>${r.me ? '<em>вы</em>' : ''}</span></td>
      <td class="top-pages"><b>${stNum(r.pages)}</b> стр.</td>
    </tr>`;
  }

  function paintTop() {
    const d = TOP.data;
    if (!d) return;
    $('#top-tabs').innerHTML = TOP_TABS.map(([k, name]) =>
      `<button type="button" class="tab${k === TOP.tab ? ' active' : ''}" role="tab" aria-selected="${k === TOP.tab}" data-top="${k}">${name}</button>`).join('');
    const sec = d[TOP.tab];
    let html = '';
    if (!sec.items.length) {
      html += `<div class="empty top-empty">${TOP_EMPTY[TOP.tab]}</div>`;
    } else {
      const rows = sec.items.map((r) => topRowHtml(TOP.tab, r)).join('');
      // читатель ниже десятого места — его строка отдельно, под списком
      const mine = sec.me && state.me
        ? `<tr class="gap"><td colspan="3">…</td></tr>${topRowHtml(TOP.tab, { rank: sec.me.rank, id: state.me.id, nick: state.me.nick, avatarVer: state.me.avatarVer, pages: sec.me.pages, me: true })}`
        : '';
      html += `<table class="top-table"><colgroup><col class="c-rank"><col><col class="c-pages"></colgroup><tbody>${rows}${mine}</tbody></table>`;
    }
    $('#top-body').innerHTML = html;
  }

  async function openTop() {
    $('#top-tabs').innerHTML = '';
    $('#top-body').innerHTML = '<p class="muted">Загрузка…</p>';
    openModal('m-top');
    try {
      TOP.data = await api('GET', `/api/top?day=${dayKey()}`);
    } catch (e) {
      $('#top-body').innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
      return;
    }
    TOP.tab = 'day';
    paintTop();
  }
  $('#nav-top').onclick = openTop;
  $('#top-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-top]');
    if (!b) return;
    TOP.tab = b.dataset.top;
    paintTop();
  });

  /* ================= Закладки и выделения по всем книгам ================= */
  const NOTES = { tab: 'highlights', books: [] };

  // разделы выделений = темы: выделения с одним названием собираются вместе из всех книг
  function noteGroups() {
    const map = new Map();
    for (const b of NOTES.books) {
      for (const h of b.highlights) {
        const name = String(b.topics?.[h.color] || '').trim();
        const key = name ? `t:${name.toLowerCase()}` : `c:${h.color}`;
        let g = map.get(key);
        if (!g) { g = { name, colors: {}, items: [] }; map.set(key, g); }
        g.colors[h.color] = (g.colors[h.color] || 0) + 1;
        g.items.push({ ...h, book: b });
      }
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.color = Object.entries(g.colors).sort((a, c) => c[1] - a[1])[0][0];
      g.label = g.name || `Без темы · ${HL_NAMES[g.color] || g.color}`;
      g.items.sort((a, c) => a.book.title.localeCompare(c.book.title, 'ru') || a.page - c.page || (a.createdAt || 0) - (c.createdAt || 0));
    }
    // сначала темы с названием, потом «без темы»
    return groups.sort((a, c) => (!!c.name - !!a.name) || c.items.length - a.items.length || a.label.localeCompare(c.label, 'ru'));
  }

  function renderNotes() {
    const body = $('#notes-body');
    const books = NOTES.books;
    const nHl = books.reduce((n, b) => n + b.highlights.length, 0);
    const nBm = books.reduce((n, b) => n + b.bookmarks.length, 0);
    const tab = (id, label, n) => `<button type="button" role="tab" class="tab ${NOTES.tab === id ? 'active' : ''}" aria-selected="${NOTES.tab === id}" data-ntab="${id}">${label} <span class="n">${n}</span></button>`;
    let list;
    // что именно стоит за каждой кнопкой «удалить всё»: номер раздела -> список заметок
    NOTES.sections = [];
    const rmBtn = (book, kind, id) => `<button type="button" class="n-rm" data-nrm="${book}|${kind}|${esc(id)}" aria-label="Удалить" title="Удалить">✕</button>`;
    const clearBtn = (items, label) => {
      NOTES.sections.push(items);
      return `<div class="n-foot"><button type="button" class="n-clear" data-nclear="${NOTES.sections.length - 1}">${label} (${items.length})</button></div>`;
    };
    if (NOTES.tab === 'highlights') {
      const groups = noteGroups();
      const openAll = nHl <= 40;
      list = groups.length ? groups.map((g, i) => `<details class="n-sec" ${openAll || i === 0 ? 'open' : ''}>
          <summary><i class="tdot c-${esc(g.color)}"></i><b dir="auto">${esc(g.label)}</b><span class="cnt">${g.items.length}</span></summary>
          ${g.items.map((h) => `<div class="n-row"><button type="button" class="n-item" data-nbook="${h.book.id}" data-npage="${h.page}">
            <i class="nbar c-${esc(h.color)}"></i>
            <span class="tx"><span class="src" dir="auto">${esc(h.book.title)} · стр. ${h.page}</span>
            <span class="q" dir="auto">${esc(String(h.text).length > 220 ? `${String(h.text).slice(0, 220)}…` : h.text)}</span></span></button>${rmBtn(h.book.id, 'highlight', h.id)}</div>`).join('')}
          ${clearBtn(g.items.map((h) => ({ book: h.book.id, kind: 'highlight', id: h.id })), 'Удалить все в этой теме')}
        </details>`).join('')
        : '<div class="r-empty">Выделений пока нет.<br>Откройте книгу и выделите текст — он появится здесь, сгруппированный по темам.</div>';
      if (nHl > 1) list += clearBtn(books.flatMap((b) => b.highlights.map((h) => ({ book: b.id, kind: 'highlight', id: h.id }))), 'Удалить все выделения');
    } else {
      const withBm = books.filter((b) => b.bookmarks.length);
      list = withBm.length ? withBm.map((b) => `<details class="n-sec" open>
          <summary><b dir="auto">${esc(b.title)}</b><span class="cnt">${b.bookmarks.length}</span></summary>
          ${[...b.bookmarks].sort((x, y) => x.page - y.page).map((m) => `<div class="n-row"><button type="button" class="n-item" data-nbook="${b.id}" data-npage="${m.page}">
            <i class="nbar"></i>
            <span class="tx"><span class="src">Страница ${m.page}</span>${b.pages > 0 ? `<span class="q">${Math.floor((m.page / b.pages) * 100)}% книги</span>` : ''}</span></button>${rmBtn(b.id, 'bookmark', m.id)}</div>`).join('')}
          ${clearBtn(b.bookmarks.map((m) => ({ book: b.id, kind: 'bookmark', id: m.id })), 'Удалить все закладки книги')}
        </details>`).join('')
        : '<div class="r-empty">Закладок пока нет.<br>Нажмите на ленточку в углу страницы в читалке.</div>';
      if (nBm > 1) list += clearBtn(books.flatMap((b) => b.bookmarks.map((m) => ({ book: b.id, kind: 'bookmark', id: m.id }))), 'Удалить все закладки');
    }
    body.innerHTML = `<div class="tabs" role="tablist">${tab('highlights', 'Выделения', nHl)}${tab('bookmarks', 'Закладки', nBm)}</div>${list}`;
  }

  // убираем удалённое и из копии на устройстве, чтобы читалка не вернула это при открытии без интернета
  function purgeLocalNotes(items) {
    const byBook = new Map();
    for (const it of items) {
      if (!byBook.has(it.book)) byBook.set(it.book, new Set());
      byBook.get(it.book).add(`${it.kind}:${it.id}`);
    }
    for (const [book, ids] of byBook) {
      let a = null;
      try { a = JSON.parse(lsGet(annKey(book)) || 'null'); } catch { /* повреждённая копия */ }
      if (!a) continue;
      if (Array.isArray(a.bookmarks)) a.bookmarks = a.bookmarks.filter((m) => !ids.has(`bookmark:${m.id}`));
      if (Array.isArray(a.highlights)) a.highlights = a.highlights.filter((h) => !ids.has(`highlight:${h.id}`));
      lsSet(annKey(book), JSON.stringify(a));
    }
  }

  async function deleteNotes(items, confirmText) {
    if (!items.length) return;
    if (confirmText && !confirm(confirmText)) return;
    try {
      const res = await api('POST', '/api/my-annotations/delete', { items });
      NOTES.books = res.books || [];
      purgeLocalNotes(items);
      renderNotes();
      toast(items.length > 1 ? `Удалено: ${res.removed ?? items.length}` : 'Удалено');
      if (state.route === 'profile') renderProfile(); // обновить счётчики
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function openNotes() {
    const body = $('#notes-body');
    body.innerHTML = '<p class="muted">Загрузка…</p>';
    openModal('m-notes');
    try {
      NOTES.books = (await api('GET', '/api/my-annotations')).books || [];
    } catch (e) {
      body.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
      return;
    }
    renderNotes();
  }

  $('#notes-body').addEventListener('click', (e) => {
    const t = e.target.closest('[data-ntab]');
    if (t) { NOTES.tab = t.dataset.ntab; renderNotes(); return; }
    const rm = e.target.closest('[data-nrm]');
    if (rm) {
      const [book, kind, ...id] = rm.dataset.nrm.split('|');
      deleteNotes([{ book: Number(book), kind, id: id.join('|') }]);
      return;
    }
    const clr = e.target.closest('[data-nclear]');
    if (clr) {
      const items = NOTES.sections?.[Number(clr.dataset.nclear)] || [];
      const what = items[0]?.kind === 'bookmark' ? 'закладок' : 'выделений';
      deleteNotes(items, `Удалить ${items.length} ${what}? Это нельзя отменить.`);
      return;
    }
    const it = e.target.closest('[data-nbook]');
    if (it) {
      closeModal($('#m-notes'));
      openReader(Number(it.dataset.nbook), Number(it.dataset.npage));
    }
  });

  /* ================= Читалка (pdf.js) ================= */
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ok */ } };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const HL_COLORS = ['yellow', 'green', 'blue', 'pink'];
  const HL_NAMES = { yellow: 'Жёлтый', green: 'Зелёный', blue: 'Синий', pink: 'Розовый' };
  const SAVED_MSG = 'Книга сохранена на устройстве и откроется без интернета';
  const BM_SVG = '<svg viewBox="0 0 24 32" aria-hidden="true"><path d="M3 1.5h18v28L12 23 3 29.5z"/></svg>';
  const TOPIC_MAX = 40;
  // маркер: цвета, толщины (доля ширины страницы) и рисунки на страницах
  const INK_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];
  const INK_HEX = { yellow: '#ffd60a', green: '#5fd94a', blue: '#3db8ff', pink: '#ff6fb5', orange: '#ff9a1f' };
  const INK_NAMES = { yellow: 'Жёлтый', green: 'Зелёный', blue: 'Синий', pink: 'Розовый', orange: 'Оранжевый' };
  const INK_SIZES = [0.010, 0.020, 0.036];
  const INK_SIZE_NAMES = ['Тонкий маркер', 'Средний маркер', 'Толстый маркер'];
  const emptyAnn = () => ({ bookmarks: [], highlights: [], strokes: [], topics: {}, legendDone: false, updatedAt: 0, dirty: false, rev: 0 });
  // темы выделений: название для каждого цвета (хранится вместе с выделениями книги)
  const cleanTopics = (t) => {
    const o = {};
    if (t && typeof t === 'object') {
      for (const c of HL_COLORS) {
        const v = typeof t[c] === 'string' ? t[c].replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX) : '';
        if (v) o[c] = v;
      }
    }
    return o;
  };

  const R = {
    doc: null, lib: null, loading: null, session: 0, book: null, total: 0,
    page: 1, spread: { l: 1, r: 0 }, twoUp: false, ref: null, lay: null, domKey: '',
    bookMode: lsGet('reader_book') === '1',
    mode: 'fit', zoom: 1, scale: 1,
    nav: 0, flipping: false, pending: null,
    cache: new Map(), tasks: new Set(),
    pgsEl: null, pgL: null, pgR: null,
    saveTimer: null, dirty: false,
    night: lsGet('reader_night') === '1',
    ann: emptyAnn(), annTimer: null, annReady: false, legendForce: false,
    popSel: null, popHl: null, pointerDown: false,
    ink: {
      on: false, tool: 'draw', hist: [], cur: null,
      color: INK_COLORS.includes(lsGet('ink_color')) ? lsGet('ink_color') : 'yellow',
      size: ['0', '1', '2'].includes(lsGet('ink_size')) ? Number(lsGet('ink_size')) : 1,
    },
  };
  const reader = $('#reader');
  const stage = $('#r-stage');
  const bookEl = $('#r-book');
  const pageInput = $('#r-page');
  const pop = $('#r-pop');
  const panel = $('#r-panel');
  const legend = $('#r-legend');
  let legendOn = false;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // pdf.js (≈500 КБ) подгружается только когда нужна читалка или загрузка PDF, а не на каждой странице
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((m) => {
        m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        return m;
      });
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  function setNight(on) {
    R.night = on;
    reader.classList.toggle('night', on);
    lsSet('reader_night', on ? '1' : '0');
  }

  function showLoading(msg, isErr = false) {
    const l = $('#r-loading');
    l.textContent = msg || '';
    l.hidden = !msg;
    l.classList.toggle('err', isErr);
  }

  const clampPage = (n) => Math.min(Math.max(1, Math.round(Number(n) || 1)), R.total || 1);
  const lastVisible = () => R.spread.r || R.spread.l || 1;
  const firstVisible = () => R.spread.l || R.spread.r || 1;

  // какие страницы видны вместе: в режиме книги обложка одна, дальше пары 2–3, 4–5…
  function spreadFor(p) {
    if (!R.twoUp) return { l: p, r: 0 };
    if (p <= 1) return { l: 0, r: 1 };
    const l = p % 2 === 0 ? p : p - 1;
    return { l, r: l + 1 <= R.total ? l + 1 : 0 };
  }

  /* ---------- Открытие и закрытие ---------- */
  async function openReader(id, goPage = 0) {
    // модуль чтения и данные книги грузим одновременно
    let pdfjsLib, book;
    try {
      [pdfjsLib, { book }] = await Promise.all([loadPdfjs(), api('GET', `/api/books/${id}`)]);
    } catch (e) {
      toast(e instanceof TypeError ? 'Не удалось загрузить модуль чтения (pdf.js). Проверьте соединение.' : e.message, true);
      return;
    }
    Object.assign(R, { book, lib: pdfjsLib, doc: null, page: 1, spread: { l: 1, r: 0 }, total: book.pages || 0, ref: null, lay: null, domKey: '', pending: null, flipping: false });
    R.mode = 'fit'; // каждая книга открывается в режиме «вписать страницу в экран»
    inkExit();
    R.nav++;
    const session = ++R.session;
    if (R.loading) { try { R.loading.destroy(); } catch { /* ok */ } R.loading = null; }
    resetPageCache();
    closePanel();
    hidePop();
    R.ann = emptyAnn();
    R.annReady = false;
    R.legendForce = false;
    syncLegend();
    setNight(R.night);
    $('#r-title').textContent = book.title;
    $('#r-title').dir = 'auto';
    pageInput.value = '';
    $('#r-total').textContent = '';
    $('#r-status').textContent = '';
    $('#r-bar').style.width = '0';
    $('#r-knob').style.left = '0';
    bookEl.replaceChildren();
    R.pgsEl = R.pgL = R.pgR = null;
    showLoading('Открываем книгу…');
    $('#r-prev').disabled = $('#r-next').disabled = pageInput.disabled = true; // пока книга грузится — листать нельзя
    reader.hidden = false;
    document.body.classList.add('no-scroll');
    history.pushState({ reader: true }, '');
    stage.focus({ preventScroll: true });
    updateReaderUi();

    let loadingTask = null;
    try {
      loadingTask = pdfjsLib.getDocument({ ...PDF_OPTS, url: pdfUrl(book), withCredentials: true });
      const doc = await loadingTask.promise;
      if (session !== R.session || reader.hidden) { loadingTask.destroy(); return; }
      R.loading = loadingTask;
      R.doc = doc;
      R.total = doc.numPages;
      // размер страниц берём не с обложки, а со второй страницы — у обложки он часто другой
      const refPage = await doc.getPage(Math.min(2, R.total));
      if (session !== R.session) return;
      const rv = refPage.getViewport({ scale: 1 });
      R.ref = { w: rv.width, h: rv.height };
      const saved = goPage || book.progress?.page || Number(lsGet(`kp_${id}`)) || 1; // goPage: открыли из закладок или выделений
      R.page = clampPage(saved);
      pageInput.max = R.total;
      $('#r-total').textContent = `/ ${R.total}`;
      await show(R.page, { save: false });
      if (session !== R.session) return;
      clearTimeout(R.readTimer);
      R.readTimer = setTimeout(recordReading, 15000); // страница открыта 15 секунд — тоже чтение
      annOpen(book);
      startReadingBeat();
      if (state.me && off.ok && getSet('open', true) && netAllowed() && navigator.onLine && !isOffline(book)) setTimeout(() => downloadBook(book), 1500);
      if (state.me && !book.progress && session === R.session) { R.dirty = true; flushProgress(); } // книга сразу попадает в «Продолжить чтение»
    } catch (e) {
      if (loadingTask && R.loading !== loadingTask) { try { loadingTask.destroy(); } catch { /* ok */ } }
      if (session !== R.session || reader.hidden) return;
      showLoading(
        e?.name === 'PasswordException' ? 'PDF защищён паролем — открыть его нельзя.'
          : e?.status === 401 || /401/.test(e?.message || '') ? 'Сессия истекла — войдите снова.'
          : !navigator.onLine ? 'Нет интернета. Эта книга не скачана для офлайн-чтения.'
          : 'Не удалось открыть книгу. Попробуйте позже.',
        true
      );
    }
  }

  function closeReader() {
    if (history.state && history.state.reader) history.back();
    else doCloseReader();
  }

  function doCloseReader() {
    if (reader.hidden) return;
    flushProgress();
    annPush(true);
    stopReadingBeat();
    stopDwell();
    clearTimeout(R.readTimer);
    R.nav++;
    R.session++;
    resetPageCache();
    if (R.loading) { try { R.loading.destroy(); } catch { /* ok */ } }
    R.loading = null;
    R.doc = null;
    R.book = null;
    R.flipping = false;
    R.pending = null;
    R.annReady = false;
    R.legendForce = false;
    syncLegend();
    hidePop();
    closePanel();
    inkExit();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    R.pseudoFull = false;
    reader.classList.remove('full');
    reader.hidden = true;
    bookEl.replaceChildren();
    R.pgsEl = R.pgL = R.pgR = null;
    if (!$$('.modal').some((m) => !m.hidden)) document.body.classList.remove('no-scroll');
    if (ROUTES.includes(state.route)) render(); // обновить прогресс на карточках
  }

  /* ---------- Размеры и отрисовка страниц ---------- */
  function resetPageCache() {
    R.tasks.forEach((t) => { try { t.cancel(); } catch { /* уже завершено */ } });
    R.tasks.clear();
    R.cache.clear();
  }

  function computeLayout() {
    R.twoUp = R.bookMode && stage.clientWidth >= 600;
    const ref = R.ref;
    const availW = Math.max(200, stage.clientWidth - 28);
    const availH = Math.max(200, stage.clientHeight - 28);
    // на широком экране вписываем страницу целиком, на телефоне — по ширине
    const wide = stage.clientWidth >= 700 && stage.clientWidth > stage.clientHeight;
    let fit;
    if (R.twoUp) fit = Math.min(availW / (ref.w * 2), availH / ref.h);
    else fit = wide ? Math.min(availW / ref.w, availH / ref.h) : availW / ref.w;
    const scale = R.mode === 'fit' ? Math.min(fit, 3) : R.zoom;
    R.scale = scale;
    R.lay = { scale, pw: ref.w * scale, ph: ref.h * scale };
    return `${R.twoUp ? 2 : 1}|${scale.toFixed(4)}|${Math.round(R.lay.pw)}x${Math.round(R.lay.ph)}`;
  }

  const CACHE_MAX = 8;
  function pageCanvas(n) {
    const sc = R.lay.scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const key = `${n}|${sc.toFixed(4)}|${dpr}`;
    let p = R.cache.get(key);
    if (p) { R.cache.delete(key); R.cache.set(key, p); return p; }
    const doc = R.doc;
    p = (async () => {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: sc * dpr });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
      R.tasks.add(task);
      try { await task.promise; } finally { R.tasks.delete(task); }
      return { canvas: c, w: c.width / dpr, h: c.height / dpr };
    })();
    R.cache.set(key, p);
    p.catch(() => { if (R.cache.get(key) === p) R.cache.delete(key); });
    while (R.cache.size > CACHE_MAX) R.cache.delete(R.cache.keys().next().value);
    return p;
  }

  const mk = (cls, tag = 'div') => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  function makePg(n, ent, slot) {
    const { pw, ph } = R.lay;
    const pg = mk(`pg ${slot}`);
    pg.style.width = `${pw}px`;
    pg.style.height = `${ph}px`;
    if (!n || !ent) { pg.classList.add('empty'); return pg; }
    pg.dataset.page = n;
    const pgi = mk('pgi');
    pgi.style.width = `${ent.w}px`;
    pgi.style.height = `${ent.h}px`;
    const c = document.createElement('canvas');
    c.width = ent.canvas.width;
    c.height = ent.canvas.height;
    c.style.width = `${ent.w}px`;
    c.style.height = `${ent.h}px`;
    c.getContext('2d').drawImage(ent.canvas, 0, 0);
    pgi.append(c, mk('hl-layer'), mk('ink-layer'), mk('textLayer'));
    const bm = mk('pg-bm', 'button');
    bm.type = 'button';
    bm.dataset.bm = n;
    bm.title = 'Закладка на этой странице';
    bm.setAttribute('aria-label', `Закладка: страница ${n}`);
    bm.innerHTML = BM_SVG;
    pg.append(pgi, bm);
    paintPg(pg);
    return pg;
  }

  // слой текста: благодаря ему текст страницы можно выделять
  async function attachText(pg) {
    const n = Number(pg?.dataset.page);
    if (!n || !R.doc || !R.lib?.TextLayer) return;
    const tl = pg.querySelector('.textLayer');
    if (!tl || tl.dataset.done) return;
    tl.dataset.done = '1';
    const session = R.session;
    try {
      const page = await R.doc.getPage(n);
      if (session !== R.session || !pg.isConnected) return;
      const vp = page.getViewport({ scale: R.lay.scale });
      tl.style.setProperty('--total-scale-factor', String(vp.scale));
      const layer = new R.lib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
      tl.style.width = `${vp.width}px`;
      tl.style.height = `${vp.height}px`;
      await layer.render();
    } catch { /* без слоя текста читать можно, выделять нельзя */ }
  }

  function buildPgs(sp, ents) {
    const { pw, ph } = R.lay;
    const pgs = mk('pgs');
    pgs.style.width = `${R.twoUp ? pw * 2 : pw}px`;
    pgs.style.height = `${ph}px`;
    let L;
    let Rr = null;
    if (R.twoUp) {
      L = makePg(sp.l, ents[0], 'l');
      Rr = makePg(sp.r, ents[1], 'r');
      pgs.append(L, Rr, mk('gutter'));
    } else {
      L = makePg(sp.l, ents[0], 's');
      pgs.append(L);
    }
    return { pgs, L, Rr };
  }

  function swapInstant(sp, ents, dir) {
    const { pgs, L, Rr } = buildPgs(sp, ents);
    bookEl.classList.toggle('single', !R.twoUp);
    bookEl.classList.remove('slide-next', 'slide-prev');
    bookEl.replaceChildren(pgs);
    R.pgsEl = pgs; R.pgL = L; R.pgR = Rr;
    if (dir && R.bookMode && !R.twoUp && !reducedMotion()) {
      void bookEl.offsetWidth;
      bookEl.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
      setTimeout(() => bookEl.classList.remove('slide-next', 'slide-prev'), 320);
    }
  }

  // перелистывание: лист поворачивается вокруг корешка, под ним уже новый разворот
  async function flipTo(dir, sp, ents, session) {
    const { pw, ph } = R.lay;
    const pgsEl = R.pgsEl;
    const oldL = R.pgL;
    const oldR = R.pgR;
    const nl = makePg(sp.l, ents[0], 'l');
    const nr = makePg(sp.r, ents[1], 'r');
    const fl = mk(`flipper ${dir > 0 ? 'fwd' : 'bwd'}`);
    fl.style.width = `${pw}px`;
    fl.style.height = `${ph}px`;
    fl.style.left = dir > 0 ? `${pw}px` : '0';
    const front = mk('face front');
    const back = mk('face back');
    front.append(mk('shade'));
    back.append(mk('shade'));
    if (dir > 0) {
      pgsEl.replaceChild(nr, oldR);
      front.prepend(oldR);
      back.prepend(nl);
    } else {
      pgsEl.replaceChild(nl, oldL);
      front.prepend(oldL);
      back.prepend(nr);
    }
    fl.append(front, back);
    bookEl.append(fl);
    R.flipping = true;
    void fl.offsetWidth;
    fl.style.transform = dir > 0 ? 'rotateY(-180deg)' : 'rotateY(180deg)';
    await new Promise((res) => {
      let done = false;
      const end = () => { if (!done) { done = true; res(); } };
      fl.addEventListener('transitionend', (e) => { if (e.target === fl && e.propertyName === 'transform') end(); });
      setTimeout(end, 900);
    });
    R.flipping = false;
    if (session !== R.session) { fl.remove(); return false; }
    if (dir > 0) pgsEl.replaceChild(nl, oldL);
    else pgsEl.replaceChild(nr, oldR);
    fl.remove();
    R.pgL = nl; R.pgR = nr;
    return true;
  }

  async function show(n, { dir = 0, save = true, force = false } = {}) {
    if (!R.doc || !R.ref) return;
    if (R.flipping) { R.pending = { n, save, force }; return; }
    const my = ++R.nav;
    const session = R.session;
    const prevKey = R.domKey;
    const key = computeLayout();
    if (key !== prevKey) resetPageCache();
    const sp = spreadFor(clampPage(n));
    const old = R.spread;
    const had = !!R.pgsEl;
    const same = had && key === prevKey && old.l === sp.l && old.r === sp.r;
    if (same && !force) { updateReaderUi(); return; }

    let ents;
    try {
      ents = await Promise.all([sp.l, sp.r].map((p) => (p ? pageCanvas(p) : null)));
    } catch (e) {
      if (my === R.nav && e?.name !== 'RenderingCancelledException') showLoading('Не удалось отобразить страницу.', true);
      return;
    }
    if (my !== R.nav || session !== R.session) return;
    showLoading('');
    hidePop();
    window.getSelection()?.removeAllRanges();

    R.spread = sp;
    R.page = sp.l || sp.r;
    R.domKey = key;
    const adjacent = had && key === prevKey && R.twoUp
      && ((dir > 0 && (sp.l || sp.r) === (old.r || old.l) + 1) || (dir < 0 && (sp.r || sp.l) === (old.l || old.r) - 1));
    if (adjacent && !reducedMotion()) {
      updateReaderUi();
      const ok = await flipTo(dir, sp, ents, session);
      if (!ok) return;
    } else {
      swapInstant(sp, ents, had && key === prevKey ? dir : 0);
      stage.scrollTo(0, 0);
    }
    [R.pgL, R.pgR].forEach((pg) => pg && attachText(pg));
    updateReaderUi();
    startDwell();
    if (save) scheduleSave();
    prefetchAround();
    if (R.pending && session === R.session) {
      const p = R.pending;
      R.pending = null;
      show(p.n, { save: p.save, force: p.force });
    }
  }

  // пока читаем разворот, соседние уже рисуются в фоне — листается без задержки
  function prefetchAround() {
    const my = R.nav;
    const session = R.session;
    setTimeout(() => {
      if (my !== R.nav || session !== R.session || !R.doc || R.flipping) return;
      const s = R.spread;
      const next = (s.r || s.l) + 1;
      const prev = (s.l || s.r) - 1;
      const want = [];
      if (next <= R.total) { const sn = spreadFor(next); want.push(sn.l, sn.r); }
      if (prev >= 1) { const sp = spreadFor(prev); want.push(sp.l, sp.r); }
      want.filter(Boolean).forEach((p) => pageCanvas(p).catch(() => {}));
    }, 250);
  }

  const relayout = () => { resetPageCache(); R.domKey = ''; return show(R.page, { save: false, force: true }); };

  /* ---------- Ползунок страниц: полоса внизу читалки ---------- */
  const SCRUB = { on: false, page: 0, timer: 0, id: null };
  const scrubEl = $('#r-scrub');
  const knobEl = $('#r-knob');
  const scrubTip = $('#r-tip');

  // рисуем полосу, бегунок и подпись для страниц first–last (при перетаскивании — для страницы под пальцем)
  function paintScrub(first, last, preview = false) {
    const frac = R.total ? Math.min(1, last / R.total) : 0;
    const pct = R.total ? Math.min(100, Math.floor(frac * 100)) : 0;
    $('#r-bar').style.width = `${frac * 100}%`;
    knobEl.style.left = `${frac * 100}%`;
    $('#r-status').textContent = first === last
      ? `Страница ${first} из ${R.total} • ${pct}%`
      : `Страницы ${first}–${last} из ${R.total} • ${pct}%`;
    scrubEl.setAttribute('aria-valuemax', String(R.total || 1));
    scrubEl.setAttribute('aria-valuenow', String(first));
    scrubEl.setAttribute('aria-valuetext', `Страница ${first} из ${R.total}`);
    if (preview) {
      scrubTip.textContent = `стр. ${last}`;
      const w = scrubEl.clientWidth;
      const tw = scrubTip.offsetWidth;
      scrubTip.style.left = `${Math.min(Math.max(frac * w - tw / 2, 0), Math.max(0, w - tw))}px`;
    }
  }

  const scrubPageAt = (clientX) => {
    const r = scrubEl.getBoundingClientRect();
    const f = r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
    return clampPage(Math.ceil(f * R.total));
  };

  function scrubTo(page) {
    if (page === SCRUB.page) return;
    SCRUB.page = page;
    paintScrub(page, page, true);
    // саму страницу рисуем не на каждый пиксель, а когда палец на секунду замедлился
    clearTimeout(SCRUB.timer);
    SCRUB.timer = setTimeout(() => { if (SCRUB.on) show(SCRUB.page); }, 90);
  }

  scrubEl.addEventListener('pointerdown', (e) => {
    if (!R.doc || !R.total || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    SCRUB.on = true;
    SCRUB.id = e.pointerId;
    SCRUB.page = 0;
    try { scrubEl.setPointerCapture(e.pointerId); } catch { /* ok */ }
    scrubEl.classList.add('scrubbing');
    scrubTip.hidden = false;
    scrubTo(scrubPageAt(e.clientX));
  });
  scrubEl.addEventListener('pointermove', (e) => {
    if (SCRUB.on && e.pointerId === SCRUB.id) scrubTo(scrubPageAt(e.clientX));
  });
  const scrubEnd = (e) => {
    if (!SCRUB.on || (e && e.pointerId !== SCRUB.id)) return;
    clearTimeout(SCRUB.timer);
    SCRUB.on = false;
    scrubEl.classList.remove('scrubbing');
    scrubTip.hidden = true;
    try { scrubEl.releasePointerCapture(SCRUB.id); } catch { /* ok */ }
    if (e?.type !== 'pointercancel' && SCRUB.page) show(SCRUB.page); // отпустили — открываем выбранную страницу
    else updateReaderUi();
  };
  scrubEl.addEventListener('pointerup', scrubEnd);
  scrubEl.addEventListener('pointercancel', scrubEnd);
  scrubEl.addEventListener('lostpointercapture', scrubEnd);

  /* ---------- Интерфейс читалки ---------- */
  function updateReaderUi() {
    const first = firstVisible();
    const last = lastVisible();
    const ready = !!R.doc && !!R.pgsEl;
    if (ready) {
      pageInput.value = first;
      pageInput.disabled = false;
      $('#r-prev').disabled = first <= 1;
      $('#r-next').disabled = last >= R.total;
      if (!SCRUB.on) paintScrub(first, last);
    }
    const bmBtn = $('#r-bookmode');
    bmBtn.classList.toggle('active', R.bookMode);
    bmBtn.setAttribute('aria-pressed', String(R.bookMode));
    const marked = ready && R.ann.bookmarks.some((b) => b.page === first);
    $('#r-bm').setAttribute('aria-pressed', String(marked));
    $('#pn-bm').textContent = R.ann.bookmarks.length;
    $('#pn-hl').textContent = R.ann.highlights.length;
    syncLegend();
    updateSaveBtn();
  }

  function updateSaveBtn() {
    const btn = $('#r-save');
    if (!btn) return;
    btn.hidden = !off.ok;
    const b = R.book;
    if (!b) return;
    const busy = off.busy.get(b.id);
    const have = busy == null && isOffline(b);
    btn.classList.toggle('saved', have);
    btn.classList.toggle('busy', busy != null);
    btn.textContent = busy != null ? `${busy}%` : '✓';
    btn.title = busy != null ? 'Скачиваем книгу…' : have ? 'Книга сохранена на устройстве' : 'Сохранить книгу на устройство для чтения без интернета';
  }

  /* ---------- Листание и прогресс ---------- */
  const goTo = (n) => show(n);
  function next() { if (!R.doc || lastVisible() >= R.total) return; show(lastVisible() + 1, { dir: 1 }); }
  function prev() { if (!R.doc || firstVisible() <= 1) return; show(firstVisible() - 1, { dir: -1 }); }

  function scheduleSave() {
    if (!R.book) return;
    lsSet(`kp_${R.book.id}`, String(lastVisible()));
    recordReading(); // перелистнул страницу — значит, читает
    R.dirty = true;
    clearTimeout(R.saveTimer);
    R.saveTimer = setTimeout(flushProgress, 700);
  }

  // Страница считается прочитанной, если пробыла открытой READ_DWELL_MS при видимой вкладке (разворот из двух страниц — вдвое дольше).
  // Перелистнул раньше или свернул вкладку — время на этой странице не копится (при возврате отсчёт продолжается).
  const READ_DWELL_MS = 12000;
  const DW = { key: '', pages: [], left: 0, since: 0, timer: 0, done: new Set() };
  function startDwell() {
    const pages = [R.spread.l, R.spread.r].filter(Boolean);
    const key = `${R.book?.id}:${pages.join(',')}`;
    if (key === DW.key) return; // тот же разворот (например, поменялся размер окна) — таймер не трогаем
    clearTimeout(DW.timer);
    DW.key = key;
    DW.pages = pages;
    DW.left = READ_DWELL_MS * Math.max(1, pages.length); // на развороте две страницы — читать их дольше
    DW.since = 0;
    resumeDwell();
  }
  function resumeDwell() {
    clearTimeout(DW.timer);
    if (!R.book || !state.me || reader.hidden || document.hidden || !DW.pages.length) return;
    if (DW.pages.every((p) => DW.done.has(`${R.book.id}:${p}`))) return; // уже засчитано в этом сеансе
    DW.since = Date.now();
    DW.timer = setTimeout(creditDwell, DW.left);
  }
  function pauseDwell() {
    if (!DW.timer) return;
    clearTimeout(DW.timer);
    DW.timer = 0;
    DW.left = Math.max(0, DW.left - (Date.now() - DW.since));
  }
  function stopDwell() {
    clearTimeout(DW.timer);
    DW.timer = 0;
    DW.key = '';
    DW.pages = [];
  }
  function creditDwell() {
    DW.timer = 0;
    if (!R.book || !state.me || reader.hidden || document.hidden) return;
    const id = R.book.id;
    const pages = DW.pages.slice();
    pages.forEach((p) => DW.done.add(`${id}:${p}`));
    fetch(`/api/read-pages/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pages, day: dayKey() }), // день — по часам устройства
      keepalive: true,
    }).catch(() => { pages.forEach((p) => DW.done.delete(`${id}:${p}`)); });
  }

  // «Читает сейчас»: пока книга открыта и вкладка на виду, раз в 45 секунд сообщаем серверу, какая книга открыта
  let nowBeatTimer = 0;
  function sendReadingNow(bookId) {
    if (!state.me) return;
    fetch('/api/reading-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ book: bookId }),
      keepalive: true,
    }).catch(() => {});
  }
  function startReadingBeat() {
    clearInterval(nowBeatTimer);
    if (!R.book) return;
    sendReadingNow(R.book.id);
    nowBeatTimer = setInterval(() => {
      if (R.book && !reader.hidden && !document.hidden) sendReadingNow(R.book.id);
    }, 45000);
  }
  function stopReadingBeat() {
    clearInterval(nowBeatTimer);
    nowBeatTimer = 0;
    sendReadingNow(0);
  }

  function flushProgress() {
    clearTimeout(R.saveTimer);
    if (!R.dirty || !R.book || !state.me) return;
    R.dirty = false;
    const id = R.book.id;
    const page = lastVisible();
    fetch(`/api/progress/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ page, day: dayKey() }), // день — по часам устройства, для статистики чтения
      keepalive: true,
    }).catch(() => { R.dirty = true; });
    if (R.book) R.book.progress = { page, updatedAt: Date.now() };
  }

  function zoomBy(factor) {
    if (!R.doc) return;
    if (R.mode === 'fit') R.zoom = R.scale;
    R.mode = 'manual';
    R.zoom = Math.min(4, Math.max(0.4, R.zoom * factor));
    updateReaderUi();
    relayout();
  }

  /* ---------- Закладки и выделения (хранятся в аккаунте + копия на устройстве) ---------- */
  const annKey = (bookId) => `ann_${state.me?.id ?? 'x'}_${bookId}`;
  function annStore(bookId, a) {
    lsSet(annKey(bookId), JSON.stringify({ bookmarks: a.bookmarks, highlights: a.highlights, strokes: a.strokes, topics: a.topics, legendDone: a.legendDone, updatedAt: a.updatedAt, dirty: a.dirty }));
  }

  function annTouch() {
    const a = R.ann;
    a.rev++;
    a.dirty = true;
    if (R.book) annStore(R.book.id, a);
    clearTimeout(R.annTimer);
    R.annTimer = setTimeout(() => annPush(), 700);
  }

  async function annPush(keepalive = false) {
    clearTimeout(R.annTimer);
    const a = R.ann;
    if (!a.dirty || !R.book || !state.me) return;
    const id = R.book.id;
    const rev = a.rev;
    try {
      const res = await fetch(`/api/annotations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ bookmarks: a.bookmarks, highlights: a.highlights, strokes: a.strokes, topics: a.topics, legendDone: a.legendDone }),
        keepalive,
      });
      if (!res.ok) throw new Error('save');
      const d = await res.json();
      if (a.rev === rev) { a.dirty = false; a.updatedAt = d.updatedAt || a.updatedAt; annStore(id, a); }
    } catch { /* нет связи — повторим при следующем изменении или при открытии книги */ }
  }

  async function annOpen(book) {
    const id = book.id;
    const session = R.session;
    let local = null;
    try { local = JSON.parse(lsGet(annKey(id)) || 'null'); } catch { /* повреждённая копия */ }
    R.ann = {
      bookmarks: Array.isArray(local?.bookmarks) ? local.bookmarks : [],
      highlights: Array.isArray(local?.highlights) ? local.highlights : [],
      strokes: Array.isArray(local?.strokes) ? local.strokes : [],
      topics: cleanTopics(local?.topics),
      legendDone: !!local?.legendDone,
      updatedAt: local?.updatedAt || 0,
      dirty: !!local?.dirty,
      rev: 0,
    };
    R.annReady = !state.me; // с аккаунтом ждём ответа сервера, чтобы плашка не мигала зря
    paintAll();
    if (!state.me) return;
    try {
      const srv = await api('GET', `/api/annotations/${id}`);
      if (session !== R.session) return;
      if (R.ann.dirty) { annPush(); return; } // на устройстве есть несохранённые правки — они главнее
      R.ann = {
        bookmarks: srv.bookmarks || [], highlights: srv.highlights || [], strokes: srv.strokes || [],
        topics: cleanTopics(srv.topics), legendDone: !!srv.legendDone,
        updatedAt: srv.updatedAt || 0, dirty: false, rev: 0,
      };
      annStore(id, R.ann);
      paintAll();
    } catch { /* офлайн — работаем с копией на устройстве */ } finally {
      if (session === R.session) { R.annReady = true; syncLegend(); }
    }
  }

  /* ---------- Темы выделений: плашка в начале книги ---------- */
  const topicName = (c) => R.ann.topics?.[c] || '';
  const colorLabel = (c) => topicName(c) || HL_NAMES[c];

  function renderLegend() {
    $('#lg-rows').innerHTML = HL_COLORS.map((c) =>
      `<label class="lg-row"><i class="tdot c-${c}"></i>
        <input type="text" data-topic="${c}" maxlength="${TOPIC_MAX}" dir="auto" autocomplete="off"
          value="${esc(topicName(c))}" placeholder="${esc(HL_NAMES[c])}" aria-label="Тема для цвета: ${esc(HL_NAMES[c])}"></label>`).join('');
  }

  // плашка видна на первой странице книги, пока не нажали «Готово»; из панели её можно открыть на любой странице
  function syncLegend() {
    const want = !!R.doc && !!R.pgsEl && !!R.book && R.annReady && (R.legendForce || (!R.ann.legendDone && firstVisible() === 1));
    if (want) legend.style.top = `${($('.reader-bar', reader)?.offsetHeight || 0) + 10}px`;
    if (want === legendOn) return;
    legendOn = want;
    legend.hidden = !want;
    if (want) renderLegend();
  }

  function closeLegend() {
    R.legendForce = false;
    if (!R.ann.legendDone) { R.ann.legendDone = true; annTouch(); }
    syncLegend();
  }

  legend.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-topic]');
    if (!inp) return;
    const v = inp.value.replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX);
    if (v) R.ann.topics[inp.dataset.topic] = v;
    else delete R.ann.topics[inp.dataset.topic];
    annTouch();
    renderPanel();
  });
  legend.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); e.target.blur(); } });
  $('#lg-ok').onclick = closeLegend;

  function paintPg(pg) {
    const n = Number(pg?.dataset.page);
    if (!n) return;
    const layer = pg.querySelector('.hl-layer');
    layer.innerHTML = R.ann.highlights.filter((h) => h.page === n).map((h) => h.rects.map((r) =>
      `<div class="hl c-${esc(h.color)}" style="left:${r[0] * 100}%;top:${r[1] * 100}%;width:${r[2] * 100}%;height:${r[3] * 100}%"></div>`).join('')).join('');
    pg.querySelector('.pg-bm')?.classList.toggle('on', R.ann.bookmarks.some((b) => b.page === n));
    const ink = pg.querySelector('.ink-layer');
    if (ink) ink.innerHTML = inkSvg(n, pg.querySelector('.pgi'));
  }

  // рисунки маркером: прямые отрезки в долях страницы; svg растягивается на всю страницу
  const inkLine = (p, w, color, ar) =>
    `<line x1="${p[0]}" y1="${p[1] * ar}" x2="${p[2]}" y2="${p[3] * ar}" stroke="${INK_HEX[color] || INK_HEX.yellow}" stroke-width="${w}"/>`;
  function inkSvg(n, pgi) {
    const w = parseFloat(pgi?.style.width) || 1;
    const h = parseFloat(pgi?.style.height) || 1;
    const ar = h / w;
    const lines = (R.ann.strokes || []).filter((s) => s.page === n && Array.isArray(s.p)).map((s) => inkLine(s.p, s.w, s.color, ar)).join('');
    return `<svg class="ink-svg" viewBox="0 0 1 ${ar}" preserveAspectRatio="none" aria-hidden="true">${lines}<g class="ink-live"></g></svg>`;
  }

  function paintAll() {
    [R.pgL, R.pgR].forEach((pg) => pg && paintPg(pg));
    updateReaderUi();
    renderPanel();
  }

  function toggleBookmark(n) {
    if (!n || !R.doc) return;
    const bms = R.ann.bookmarks;
    const i = bms.findIndex((b) => b.page === n);
    if (i >= 0) bms.splice(i, 1);
    else bms.push({ id: uid(), page: n, createdAt: Date.now() });
    annTouch();
    paintAll();
    toast(i >= 0 ? `Закладка удалена (стр. ${n})` : `Закладка добавлена: страница ${n}`);
  }

  // склеиваем прямоугольники одной строки, чтобы выделение было сплошным
  function mergeRects(list) {
    const rs = list.filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom }))
      .sort((a, b) => a.t - b.t || a.l - b.l);
    const out = [];
    for (const r of rs) {
      const o = out.find((x) => {
        const ov = Math.min(x.b, r.b) - Math.max(x.t, r.t);
        const minH = Math.min(x.b - x.t, r.b - r.t);
        const gap = Math.max(r.l - x.r, x.l - r.r);
        return ov > minH * 0.5 && gap < minH * 0.8;
      });
      if (o) { o.l = Math.min(o.l, r.l); o.r = Math.max(o.r, r.r); o.t = Math.min(o.t, r.t); o.b = Math.max(o.b, r.b); }
      else out.push({ ...r });
    }
    return out;
  }

  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const parts = [];
    for (const pg of [R.pgL, R.pgR]) {
      if (!pg?.dataset.page) continue;
      const tl = pg.querySelector('.textLayer');
      if (!tl || !range.intersectsNode(tl)) continue;
      const whole = document.createRange();
      whole.selectNodeContents(tl);
      const cl = range.cloneRange();
      if (cl.compareBoundaryPoints(Range.START_TO_START, whole) < 0) cl.setStart(whole.startContainer, whole.startOffset);
      if (cl.compareBoundaryPoints(Range.END_TO_END, whole) > 0) cl.setEnd(whole.endContainer, whole.endOffset);
      const text = cl.toString().replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const box = pg.querySelector('.pgi').getBoundingClientRect();
      const clamp01 = (v) => Math.min(1, Math.max(0, v));
      const rects = mergeRects([...cl.getClientRects()]).map((r) => {
        const x = clamp01((r.l - box.left) / box.width);
        const y = clamp01((r.t - box.top) / box.height);
        return [x, y, clamp01((r.r - box.left) / box.width) - x, clamp01((r.b - box.top) / box.height) - y];
      }).filter((r) => r[2] > 0.002 && r[3] > 0.002);
      if (rects.length) parts.push({ page: Number(pg.dataset.page), rects, text });
    }
    if (!parts.length) return null;
    const bb = range.getBoundingClientRect();
    return { parts, rect: { left: bb.left, right: bb.right, top: bb.top, bottom: bb.bottom } };
  }

  /* меню над выделенным текстом */
  // цвет с названием темы показываем «таблеткой» с подписью, без названия — просто кружком
  const swatches = (active) => HL_COLORS.map((c) => {
    const name = topicName(c);
    return `<button type="button" class="sw ${name ? 'tp' : ''} ${c === active ? 'on' : ''}" data-c="${c}" title="${esc(colorLabel(c))}" aria-label="${esc(colorLabel(c))}"><i></i>${name ? `<span>${esc(name)}</span>` : ''}</button>`;
  }).join('');

  function placePop(rect, preferBelow) {
    pop.hidden = false;
    const h = pop.offsetHeight || 44;
    const w = pop.offsetWidth || 220;
    const cx = Math.min(Math.max((rect.left + rect.right) / 2, w / 2 + 8), window.innerWidth - w / 2 - 8);
    let top = preferBelow ? rect.bottom + 12 : rect.top - h - 10;
    if (top < 56) top = rect.bottom + 12;
    if (top + h > window.innerHeight - 8) top = Math.max(56, rect.top - h - 10);
    pop.style.left = `${cx}px`;
    pop.style.top = `${top}px`;
  }

  function hidePop() {
    if (pop.hidden && !R.popSel && !R.popHl) return;
    pop.hidden = true;
    R.popSel = null;
    R.popHl = null;
  }

  function showSelPop(cap) {
    R.popSel = cap;
    R.popHl = null;
    pop.innerHTML = `${swatches('')}<i class="sep"></i><button type="button" class="pb" data-act="copy">Копировать</button>`;
    placePop(cap.rect, matchMedia('(pointer: coarse)').matches);
  }

  function showHlPop(h, rect) {
    R.popHl = h.id;
    R.popSel = null;
    pop.innerHTML = `${swatches(h.color)}<i class="sep"></i><button type="button" class="pb del" data-act="del">Удалить</button>`;
    placePop(rect, false);
  }

  function addHighlight(color) {
    const cap = R.popSel;
    if (!cap) return;
    const t = Date.now();
    for (const p of cap.parts) R.ann.highlights.push({ id: uid(), page: p.page, rects: p.rects, text: p.text, color, createdAt: t });
    window.getSelection()?.removeAllRanges();
    hidePop();
    annTouch();
    paintAll();
    toast('Выделение сохранено');
  }

  pop.addEventListener('pointerdown', (e) => e.preventDefault()); // не сбрасываем выделение при нажатии
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-c]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (sw) {
      if (R.popHl) {
        const h = R.ann.highlights.find((x) => x.id === R.popHl);
        if (h) { h.color = sw.dataset.c; annTouch(); paintAll(); }
        hidePop();
      } else addHighlight(sw.dataset.c);
    } else if (act === 'copy') {
      const text = R.popSel?.parts.map((p) => p.text).join(' ') || '';
      try { await navigator.clipboard.writeText(text); toast('Текст скопирован'); } catch { toast('Не удалось скопировать', true); }
      window.getSelection()?.removeAllRanges();
      hidePop();
    } else if (act === 'del') {
      R.ann.highlights = R.ann.highlights.filter((x) => x.id !== R.popHl);
      hidePop();
      annTouch();
      paintAll();
      toast('Выделение удалено');
    }
  });

  let selTimer;
  function onSelectionSettled() {
    if (reader.hidden || R.flipping || R.pointerDown) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { if (R.popSel) hidePop(); return; }
    if (!sel.anchorNode?.parentElement?.closest('.textLayer')) return;
    const cap = captureSelection();
    if (cap) showSelPop(cap); else hidePop();
  }
  document.addEventListener('selectionchange', () => {
    if (reader.hidden) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(onSelectionSettled, 260);
  });
  stage.addEventListener('pointerdown', (e) => {
    R.pointerDown = true;
    if (!e.target.closest('.hl-pop')) hidePop();
  });
  const pointerUp = () => {
    if (!R.pointerDown) return;
    R.pointerDown = false;
    clearTimeout(selTimer);
    selTimer = setTimeout(onSelectionSettled, 60);
  };
  window.addEventListener('pointerup', pointerUp);
  window.addEventListener('pointercancel', pointerUp);

  // выделение под точкой клика (если есть)
  function highlightAt(e) {
    const pg = e.target.closest('.pg');
    if (!pg?.dataset.page) return null;
    const n = Number(pg.dataset.page);
    const box = pg.querySelector('.pgi').getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    for (const h of R.ann.highlights) {
      if (h.page !== n) continue;
      const r = h.rects.find((q) => x >= q[0] && x <= q[0] + q[2] && y >= q[1] && y <= q[1] + q[3]);
      if (r) return { h, rect: { left: box.left + r[0] * box.width, right: box.left + (r[0] + r[2]) * box.width, top: box.top + r[1] * box.height, bottom: box.top + (r[1] + r[3]) * box.height } };
    }
    return null;
  }

  // нажатие на уже выделенный текст — меню «цвет / удалить»
  stage.addEventListener('click', (e) => {
    if (R.flipping) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (e.target.closest('.pg-bm')) return;
    const hit = highlightAt(e);
    if (hit) showHlPop(hit.h, hit.rect);
    else hidePop();
  });

  // полный экран: листаем нажатием на левую и правую стороны книги
  stage.addEventListener('click', (e) => {
    if (!reader.classList.contains('full') || R.flipping || !R.doc) return;
    if (e.target.closest('.pg-bm, .hl-pop, button, input, a')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (highlightAt(e)) return;
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.35) prev();
    else if (x > 0.65) next();
  });

  stage.addEventListener('click', (e) => {
    const bm = e.target.closest('.pg-bm');
    if (bm) toggleBookmark(Number(bm.dataset.bm));
  });

  /* ---------- Маркер: рисование прямых линий поверх страницы ---------- */
  const inkBar = $('#ink-bar');
  const inkBtn = $('#r-ink');

  function inkPaintBar() {
    const k = R.ink;
    $$('[data-ic]', inkBar).forEach((b) => b.classList.toggle('on', k.tool === 'draw' && b.dataset.ic === k.color));
    const sz = $('#ink-size');
    sz.style.setProperty('--h', `${[4, 8, 14][k.size]}px`);
    sz.title = `${INK_SIZE_NAMES[k.size]} — нажмите, чтобы сменить толщину`;
    sz.setAttribute('aria-label', INK_SIZE_NAMES[k.size]);
    const er = $('#ink-erase');
    er.setAttribute('aria-pressed', String(k.tool === 'erase'));
    $('#ink-undo').disabled = !k.hist.length;
    reader.classList.toggle('erasing', k.on && k.tool === 'erase');
  }

  function inkEnter() {
    if (!R.doc || R.ink.on) return;
    R.ink.on = true;
    R.ink.tool = 'draw';
    R.ink.hist = [];
    hidePop();
    window.getSelection()?.removeAllRanges();
    reader.classList.add('drawing');
    inkBar.hidden = false;
    inkBtn.setAttribute('aria-pressed', 'true');
    inkPaintBar();
  }

  function inkExit() {
    const k = R.ink;
    if (!k.on && inkBar.hidden) return;
    k.on = false;
    k.cur = null;
    k.hist = [];
    reader.classList.remove('drawing', 'erasing');
    inkBar.hidden = true;
    inkBtn.setAttribute('aria-pressed', 'false');
    $$('.ink-live', reader).forEach((g) => { g.innerHTML = ''; });
  }

  // отрезок от точки нажатия до текущей; почти горизонтальную или вертикальную линию выравниваем
  function inkSegment(c) {
    let { x1, y1 } = c;
    const dx = (x1 - c.x0) * c.box.width;
    const dy = (y1 - c.y0) * c.box.height;
    if (Math.abs(dy) < Math.abs(dx) * 0.1) y1 = c.y0;
    else if (Math.abs(dx) < Math.abs(dy) * 0.1) x1 = c.x0;
    return { p: [c.x0, c.y0, x1, y1], len: Math.hypot((x1 - c.x0) * c.box.width, (y1 - c.y0) * c.box.height) };
  }

  function inkLive(c) {
    const g = c.pg.querySelector('.ink-live');
    if (!g) return;
    g.innerHTML = inkLine(inkSegment(c).p, INK_SIZES[R.ink.size], R.ink.color, c.box.height / c.box.width);
  }

  const segDist = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax;
    const vy = by - ay;
    const l2 = vx * vx + vy * vy;
    const t = l2 ? Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  };

  // стёрка убирает рисунки, которых коснулась
  function inkErase(c) {
    const ar = c.box.height / c.box.width;
    const hit = R.ann.strokes.filter((s) => s.page === c.page && segDist(c.x1, c.y1 * ar, s.p[0], s.p[1] * ar, s.p[2], s.p[3] * ar) <= 0.02 + s.w / 2);
    if (!hit.length) return;
    R.ann.strokes = R.ann.strokes.filter((s) => !hit.includes(s));
    c.removed.push(...hit);
    paintPg(c.pg);
  }

  function inkUndo() {
    const k = R.ink;
    const h = k.hist.pop();
    if (!h) return;
    if (h.t === 'add') R.ann.strokes = R.ann.strokes.filter((s) => s.id !== h.s.id);
    else R.ann.strokes.push(...h.list);
    annTouch();
    paintAll();
    inkPaintBar();
  }

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const inkRound = (v) => Math.round(v * 10000) / 10000;

  stage.addEventListener('pointerdown', (e) => {
    const k = R.ink;
    if (!k.on || k.cur || R.flipping || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const pgi = e.target.closest?.('.pgi');
    if (!pgi || e.target.closest('.pg-bm')) return;
    const pg = pgi.closest('.pg');
    const page = Number(pg?.dataset.page);
    if (!page) return;
    e.preventDefault();
    e.stopPropagation();
    const box = pgi.getBoundingClientRect();
    const x = clamp01((e.clientX - box.left) / box.width);
    const y = clamp01((e.clientY - box.top) / box.height);
    k.cur = { id: e.pointerId, pg, pgi, page, box, x0: x, y0: y, x1: x, y1: y, removed: [] };
    try { pgi.setPointerCapture(e.pointerId); } catch { /* ok */ }
    if (k.tool === 'erase') inkErase(k.cur);
  }, true);

  stage.addEventListener('pointermove', (e) => {
    const c = R.ink.cur;
    if (!c || e.pointerId !== c.id) return;
    e.preventDefault();
    c.x1 = clamp01((e.clientX - c.box.left) / c.box.width);
    c.y1 = clamp01((e.clientY - c.box.top) / c.box.height);
    if (R.ink.tool === 'erase') inkErase(c); else inkLive(c);
  }, true);

  function inkFinish(e, cancel) {
    const k = R.ink;
    const c = k.cur;
    if (!c || e.pointerId !== c.id) return;
    k.cur = null;
    try { c.pgi.releasePointerCapture(c.id); } catch { /* ok */ }
    const g = c.pg.querySelector('.ink-live');
    if (g) g.innerHTML = '';
    if (k.tool === 'erase') {
      if (c.removed.length) { k.hist.push({ t: 'del', list: c.removed }); annTouch(); }
    } else if (!cancel) {
      const seg = inkSegment(c);
      if (seg.len >= 6) { // совсем короткие касания не считаем линией
        const s = { id: uid(), page: c.page, color: k.color, w: INK_SIZES[k.size], p: seg.p.map(inkRound), createdAt: Date.now() };
        R.ann.strokes.push(s);
        k.hist.push({ t: 'add', s });
        annTouch();
        paintPg(c.pg);
      }
    }
    if (k.hist.length > 200) k.hist.shift();
    inkPaintBar();
  }
  stage.addEventListener('pointerup', (e) => inkFinish(e, false), true);
  stage.addEventListener('pointercancel', (e) => inkFinish(e, true), true);

  // пока рисуем — нажатия не открывают меню выделения и не листают страницы
  stage.addEventListener('click', (e) => {
    if (R.ink.on && !e.target.closest('.pg-bm')) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  inkBtn.onclick = () => (R.ink.on ? inkExit() : inkEnter());
  $('#ink-done').onclick = inkExit;
  inkBar.addEventListener('click', (e) => {
    const k = R.ink;
    const col = e.target.closest('[data-ic]');
    if (col) { k.color = col.dataset.ic; k.tool = 'draw'; lsSet('ink_color', k.color); }
    else if (e.target.closest('#ink-size')) { k.size = (k.size + 1) % INK_SIZES.length; lsSet('ink_size', String(k.size)); }
    else if (e.target.closest('#ink-erase')) k.tool = k.tool === 'erase' ? 'draw' : 'erase';
    else if (e.target.closest('#ink-undo')) { inkUndo(); return; }
    else return;
    inkPaintBar();
  });
  document.addEventListener('keydown', (e) => {
    if (!R.ink.on || reader.hidden) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')) { e.preventDefault(); inkUndo(); }
  });

  /* панель «Закладки и выделения» */
  let panelTab = 'bookmarks';
  let hlFilter = ''; // показывать выделения только одного цвета (темы)
  function openPanel(tab) {
    if (tab) panelTab = tab;
    panel.hidden = false;
    $('#r-notes').setAttribute('aria-pressed', 'true');
    renderPanel();
  }
  function closePanel() {
    panel.hidden = true;
    $('#r-notes')?.setAttribute('aria-pressed', 'false');
  }
  function renderPanel() {
    if (panel.hidden) return;
    $$('[data-ptab]', panel).forEach((t) => {
      const on = t.dataset.ptab === panelTab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    const body = $('#r-panel-body');
    if (panelTab === 'bookmarks') {
      const list = [...R.ann.bookmarks].sort((a, b) => a.page - b.page);
      const here = firstVisible();
      const has = list.some((b) => b.page === here);
      body.innerHTML = `<button type="button" class="btn ghost r-add" data-pbm="${here}">${has ? `Убрать закладку со стр. ${here}` : `Добавить закладку на стр. ${here}`}</button>`
        + (list.length ? list.map((b) => `<div class="r-item" data-go="${b.page}"><i class="bar"></i>
            <div class="tx"><b>Страница ${b.page}</b><span>${R.total ? `${Math.floor((b.page / R.total) * 100)}% книги` : ''}</span></div>
            <button type="button" class="rm" data-rm-bm="${esc(b.id)}" aria-label="Удалить закладку" title="Удалить">✕</button></div>`).join('')
          : '<div class="r-empty">Закладок пока нет.<br>Нажмите на ленточку в углу страницы или на кнопку выше.</div>');
    } else {
      const all = R.ann.highlights;
      const cnt = (c) => all.filter((h) => h.color === c).length;
      if (hlFilter && !cnt(hlFilter) && !topicName(hlFilter)) hlFilter = '';
      const chips = `<div class="hl-filter">
          <button type="button" class="chip ${hlFilter ? '' : 'on'}" data-hf="">Все <span>${all.length}</span></button>
          ${HL_COLORS.filter((c) => cnt(c) || topicName(c)).map((c) =>
            `<button type="button" class="chip ${hlFilter === c ? 'on' : ''}" data-hf="${c}"><i class="tdot c-${c}"></i>${esc(colorLabel(c))} <span>${cnt(c)}</span></button>`).join('')}
          <button type="button" class="chip edit" data-topics-edit>✎ Темы</button></div>`;
      const list = all.filter((h) => !hlFilter || h.color === hlFilter).sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
      body.innerHTML = chips + (list.length ? list.map((h) => `<div class="r-item" data-go="${h.page}"><i class="bar c-${esc(h.color)}"></i>
          <div class="tx"><b>Страница ${h.page}${topicName(h.color) ? ` · ${esc(topicName(h.color))}` : ''}</b><span dir="auto">${esc(h.text.length > 180 ? `${h.text.slice(0, 180)}…` : h.text)}</span></div>
          <button type="button" class="rm" data-rm-hl="${esc(h.id)}" aria-label="Удалить выделение" title="Удалить">✕</button></div>`).join('')
        : all.length ? '<div class="r-empty">В этой теме выделений пока нет.</div>'
        : '<div class="r-empty">Выделений пока нет.<br>Выделите текст на странице — появится меню с цветами.</div>');
    }
  }
  panel.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ptab]');
    if (t) { panelTab = t.dataset.ptab; renderPanel(); return; }
    const hf = e.target.closest('[data-hf]');
    if (hf) { hlFilter = hf.dataset.hf; renderPanel(); return; }
    if (e.target.closest('[data-topics-edit]')) {
      R.legendForce = true;
      syncLegend();
      if (window.innerWidth < 700) closePanel();
      legend.querySelector('input')?.focus({ preventScroll: true });
      return;
    }
    const addBm = e.target.closest('[data-pbm]');
    if (addBm) { toggleBookmark(Number(addBm.dataset.pbm)); return; }
    const rmBm = e.target.closest('[data-rm-bm]');
    if (rmBm) { R.ann.bookmarks = R.ann.bookmarks.filter((b) => b.id !== rmBm.dataset.rmBm); annTouch(); paintAll(); return; }
    const rmHl = e.target.closest('[data-rm-hl]');
    if (rmHl) { R.ann.highlights = R.ann.highlights.filter((h) => h.id !== rmHl.dataset.rmHl); annTouch(); paintAll(); return; }
    const go = e.target.closest('[data-go]');
    if (go) {
      goTo(Number(go.dataset.go));
      if (window.innerWidth < 700) closePanel();
    }
  });
  $('#r-panel-x').onclick = closePanel;

  // Esc сначала закрывает меню или панель, и только потом читалку
  function readerEscape() {
    if (!pop.hidden) { hidePop(); return true; }
    if (R.ink.on) { inkExit(); return true; }
    if (legendOn) { closeLegend(); return true; }
    if (!panel.hidden) { closePanel(); return true; }
    if (R.pseudoFull) { R.pseudoFull = false; applyFull(); return true; }
    return false;
  }

  /* ---------- Кнопки и клавиши ---------- */
  window.addEventListener('popstate', () => { if (!reader.hidden) doCloseReader(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pauseDwell(); flushProgress(); annPush(true); if (R.book) sendReadingNow(0); }
    else if (R.book && !reader.hidden) { resumeDwell(); sendReadingNow(R.book.id); } // вернулся к книге — снова «читает»
  });
  window.addEventListener('pagehide', () => { flushProgress(); annPush(true); if (R.book) sendReadingNow(0); });
  window.addEventListener('online', () => annPush());

  $('#r-close').onclick = closeReader;
  $('#r-prev').onclick = prev;
  $('#r-next').onclick = next;
  $('#r-zoom-in').onclick = () => zoomBy(1.2);
  $('#r-zoom-out').onclick = () => zoomBy(1 / 1.2);
  $('#r-night').onclick = () => setNight(!R.night);
  $('#r-bookmode').onclick = () => {
    R.bookMode = !R.bookMode;
    lsSet('reader_book', R.bookMode ? '1' : '0');
    updateReaderUi();
    if (R.doc) relayout();
    toast(R.bookMode ? 'Режим книги: разворот на две страницы' : 'Режим одной страницы');
  };
  $('#r-bm').onclick = () => toggleBookmark(firstVisible());
  $('#r-notes').onclick = () => (panel.hidden ? openPanel() : closePanel());
  $('#r-save').onclick = async () => {
    const b = R.book;
    if (!b) return;
    if (!off.ok) { toast('Этот браузер не умеет сохранять книги на устройство', true); return; }
    if (isOffline(b)) { toast(SAVED_MSG); return; }
    if (off.busy.has(b.id)) { toast('Книга уже скачивается…'); return; }
    toast('Скачиваем книгу…');
    const ok = await downloadBook(b);
    if (ok && isOffline(b)) toast(SAVED_MSG);
  };
  pageInput.addEventListener('change', () => goTo(pageInput.value));
  pageInput.addEventListener('focus', () => pageInput.select());

  // Полный экран. Где браузер умеет (компьютер, Android) — настоящий; где нет (iPhone) — «облегчённый»:
  // убираем лишнее с экрана читалки. В обоих случаях нижняя плашка уходит, листаем нажатием на края.
  const nativeFull = () => document.fullscreenElement === reader || document.webkitFullscreenElement === reader;
  function applyFull() {
    reader.classList.toggle('full', nativeFull() || !!R.pseudoFull);
    if (!reader.hidden && R.doc && R.mode === 'fit') relayout();
  }
  async function toggleFull() {
    if (nativeFull()) { try { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { /* ok */ } return; }
    if (R.pseudoFull) { R.pseudoFull = false; applyFull(); return; }
    const req = reader.requestFullscreen || reader.webkitRequestFullscreen;
    if (req && document.fullscreenEnabled !== false) {
      try { await req.call(reader); return; } catch { /* браузер отказал — включаем облегчённый режим */ }
    }
    R.pseudoFull = true;
    applyFull();
  }
  $('#r-full').onclick = toggleFull;
  $('#r-full-exit').onclick = toggleFull;
  const onFullChange = applyFull;
  document.addEventListener('fullscreenchange', onFullChange);
  document.addEventListener('webkitfullscreenchange', onFullChange);

  document.addEventListener('keydown', (e) => {
    if (reader.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches('input, textarea, select')) return;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': next(); break;
      case 'ArrowLeft': case 'PageUp': prev(); break;
      case 'Home': goTo(1); break;
      case 'End': goTo(R.total); break;
      case '+': case '=': zoomBy(1.2); break;
      case '-': zoomBy(1 / 1.2); break;
      case 'b': case 'B': toggleBookmark(firstVisible()); break;
      default: return;
    }
    e.preventDefault();
  });

  let rzTimer;
  window.addEventListener('resize', () => {
    if (reader.hidden || !R.doc) return;
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      const twoUp = R.bookMode && stage.clientWidth >= 600;
      if (R.mode === 'fit' || twoUp !== R.twoUp) relayout();
    }, 200);
  });

  // свайп для листания (когда страница целиком влезает по ширине)
  let touch = null;
  stage.addEventListener('touchstart', (e) => {
    touch = e.touches.length === 1 && !R.ink.on ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!touch || R.ink.on || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // человек выделяет текст, а не листает
    if (Math.abs(dx) < 70 || Math.abs(dy) > 50 || stage.scrollWidth > stage.clientWidth + 2) return;
    if (dx < 0) next(); else prev();
  }, { passive: true });

  /* ================= Управление библиотекой ================= */
  const form = $('#book-form');
  const M = { edit: null, pdfFile: null, customCover: null, genCover: null, pages: 0, previewUrl: null };

  function setPreview(src) {
    const el = $('#cover-preview');
    if (M.previewUrl) { URL.revokeObjectURL(M.previewUrl); M.previewUrl = null; }
    if (!src) { el.innerHTML = '<span>Обложка</span>'; return; }
    if (src instanceof Blob) { M.previewUrl = URL.createObjectURL(src); src = M.previewUrl; }
    el.innerHTML = `<img src="${esc(src)}" alt="">`;
  }

  function resetForm() {
    form.reset();
    Object.assign(M, { edit: null, pdfFile: null, customCover: null, genCover: null, pages: 0 });
    form.pages.value = '';
    $('#pdf-name').innerHTML = '<strong>PDF не выбран</strong>';
    $('#pdf-hint').textContent = 'Число страниц и обложка определятся автоматически.';
    $('#form-heading').textContent = 'Добавить книгу';
    $('#book-submit').textContent = 'Сохранить книгу';
    $('#book-cancel').hidden = true;
    $('#book-error').textContent = '';
    $('#upload-progress').hidden = true;
    setPreview(null);
  }

  /* ---------- Резервная копия: восстановление из файла ---------- */
  $('#restore-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const msg = $('#restore-msg');
    msg.classList.remove('ok');
    if (!confirm(`Восстановить данные из «${file.name}»?\n\nВсе текущие книги, аккаунты и закладки на этом сайте будут ЗАМЕНЕНЫ содержимым копии. Прежние данные сохранятся на сервере в папке before-restore.`)) return;
    const prog = $('#restore-progress');
    prog.hidden = false;
    $('#restore-bar').style.width = '0';
    $('#restore-pct').textContent = '0%';
    msg.textContent = 'Загружаем копию…';
    const x = new XMLHttpRequest();
    x.open('POST', '/api/admin/restore');
    x.setRequestHeader('X-Restore-Confirm', 'yes');
    x.setRequestHeader('Content-Type', 'application/x-tar');
    x.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const p = Math.round((ev.loaded / ev.total) * 100);
      $('#restore-bar').style.width = `${p}%`;
      $('#restore-pct').textContent = `${p}%`;
    };
    x.onerror = () => { prog.hidden = true; msg.textContent = 'Связь прервалась. Копия не применена — попробуйте ещё раз.'; };
    x.onload = async () => {
      if (x.status !== 200) {
        prog.hidden = true;
        let m = 'Не удалось восстановить копию';
        try { m = JSON.parse(x.responseText).error || m; } catch { /* ok */ }
        msg.textContent = m;
        return;
      }
      msg.classList.add('ok');
      msg.textContent = 'Копия принята. Сервер перезапускается…';
      // ждём, пока сервер поднимется с новыми данными, и перезагружаем страницу
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        try { const r = await fetch('/healthz', { cache: 'no-store' }); if (r.ok && i > 1) { location.reload(); return; } } catch { /* сервер ещё перезапускается */ }
      }
      msg.textContent = 'Сервер не вернулся за 90 секунд. Проверьте его вручную: данные уже приняты.';
    };
    x.send(file);
  });

  async function openManage() {
    if (!state.me?.isAdmin) return;
    resetForm();
    openModal('m-manage');
    await refreshManageList();
  }

  async function refreshManageList() {
    const list = $('#manage-list');
    try {
      const [{ books }, { sections }] = await Promise.all([api('GET', '/api/books'), api('GET', '/api/sections')]);
      $('#section-list').innerHTML = sections.map((s) => `<option value="${esc(s.name)}"></option>`).join('');
      list.innerHTML = books.length
        ? books.map((b) => `
          <div class="m-item" data-id="${b.id}">
            ${thumbHtml(b)}
            <div class="txt"><b dir="auto">${esc(b.title)}</b>
              <span class="sub" dir="auto">${esc([b.author, b.section, LANG_NAME[b.language], b.pages ? `${b.pages} стр.` : ''].filter(Boolean).join(' · '))}</span></div>
            <div class="actions">
              <button type="button" class="btn ghost small" data-m-read="${b.id}">Читать</button>
              <button type="button" class="btn ghost small" data-m-edit="${b.id}">Изменить</button>
              <button type="button" class="btn danger small" data-m-del="${b.id}">Удалить</button>
            </div>
          </div>`).join('')
        : '<p class="muted">Книг пока нет. Добавьте первую через форму выше.</p>';
      list._books = books;
    } catch (e) {
      list.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
    }
  }

  $('#manage-list').addEventListener('click', async (e) => {
    const list = $('#manage-list');
    const read = e.target.closest('[data-m-read]');
    const edit = e.target.closest('[data-m-edit]');
    const del = e.target.closest('[data-m-del]');
    if (read) {
      closeModal($('#m-manage'));
      openReader(Number(read.dataset.mRead));
    } else if (edit) {
      const b = (list._books || []).find((x) => x.id === Number(edit.dataset.mEdit));
      if (b) startEdit(b);
    } else if (del) {
      const b = (list._books || []).find((x) => x.id === Number(del.dataset.mDel));
      if (!b || !confirm(`Удалить «${b.title}» из библиотеки? Файл книги будет удалён безвозвратно.`)) return;
      try {
        await api('DELETE', `/api/books/${b.id}`);
        toast('Книга удалена');
        if (M.edit?.id === b.id) resetForm();
        await refreshManageList();
        if (ROUTES.includes(state.route)) render();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  function startEdit(b) {
    resetForm();
    M.edit = b;
    for (const k of ['title', 'author', 'translator', 'publisher', 'section', 'language', 'description']) {
      form[k].value = b[k] || '';
    }
    form.pages.value = b.pages || '';
    $('#form-heading').textContent = 'Редактировать книгу';
    $('#book-submit').textContent = 'Сохранить изменения';
    $('#book-cancel').hidden = false;
    $('#pdf-name').innerHTML = '<strong>Файл книги не меняется</strong>';
    $('#pdf-hint').textContent = 'Чтобы заменить файл, загрузите другой PDF — прогресс чтения по этой книге сбросится.';
    setPreview(b.hasCover ? `/api/books/${b.id}/cover?v=${b.version}` : null);
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#book-cancel').onclick = resetForm;

  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

  $('#pdf-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      $('#book-error').textContent = 'Нужен файл в формате PDF';
      return;
    }
    $('#book-error').textContent = '';
    M.pdfFile = file;
    M.genCover = null;
    $('#pdf-name').innerHTML = `<strong>${esc(file.name)}</strong> · ${fmtSize(file.size)}`;
    $('#pdf-hint').textContent = 'Читаем файл…';
    if (!form.title.value.trim()) {
      form.title.value = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
    }
    let pdfjsLib;
    try {
      pdfjsLib = await loadPdfjs();
    } catch {
      $('#pdf-hint').textContent = 'Не удалось загрузить pdf.js — число страниц и обложка не определены.';
      return;
    }
    const url = URL.createObjectURL(file);
    let task = null;
    try {
      task = pdfjsLib.getDocument({ ...PDF_OPTS, url });
      const doc = await task.promise;
      M.pages = doc.numPages;
      form.pages.value = doc.numPages;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 520 / base.width });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      M.genCover = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (!M.customCover && M.genCover) setPreview(M.genCover);
      $('#pdf-hint').textContent = `Страниц: ${M.pages}. Обложка взята с первой страницы.`;
    } catch {
      M.pages = 0;
      form.pages.value = '';
      $('#pdf-hint').textContent = 'Не удалось прочитать PDF. Проверьте файл — возможно, он повреждён или защищён паролем.';
    } finally {
      if (task) { try { task.destroy(); } catch { /* ok */ } }
      URL.revokeObjectURL(url);
    }
  });

  $('#cover-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      $('#book-error').textContent = 'Обложка: JPG, PNG или WebP';
      return;
    }
    $('#book-error').textContent = '';
    M.customCover = file;
    setPreview(file);
  });

  function sendForm(method, url, fd, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.withCredentials = true;
      x.upload.onprogress = (ev) => ev.lengthComputable && onProgress(ev.loaded / ev.total);
      x.onload = () => {
        let d = null;
        try { d = JSON.parse(x.responseText); } catch { /* не JSON */ }
        if (x.status >= 200 && x.status < 300) resolve(d);
        else reject(new Error(d?.error || `Ошибка ${x.status}`));
      };
      x.onerror = () => reject(new Error('Нет связи с сервером'));
      x.send(fd);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#book-error');
    err.textContent = '';
    if (!M.edit && !M.pdfFile) { err.textContent = 'Выберите PDF-файл'; return; }
    if (!form.title.value.trim() || !form.section.value.trim()) { err.textContent = 'Укажите название и раздел'; return; }

    const fd = new FormData();
    for (const k of ['title', 'author', 'translator', 'publisher', 'section', 'language', 'description', 'pages']) {
      fd.append(k, form[k].value);
    }
    if (M.pdfFile) fd.append('pdf', M.pdfFile, M.pdfFile.name);
    const cover = M.customCover || (M.pdfFile ? M.genCover : null);
    if (cover) fd.append('cover', cover, M.customCover ? M.customCover.name : 'cover.jpg');

    const btn = $('#book-submit');
    const prog = $('#upload-progress');
    btn.disabled = true;
    prog.hidden = false;
    $('#upload-bar').style.width = '0';
    $('#upload-pct').textContent = '';
    try {
      await sendForm(M.edit ? 'PUT' : 'POST', M.edit ? `/api/books/${M.edit.id}` : '/api/books', fd, (f) => {
        $('#upload-bar').style.width = `${Math.round(f * 100)}%`;
        $('#upload-pct').textContent = f < 1 ? `Загрузка… ${Math.round(f * 100)}%` : 'Сохраняем…';
      });
      toast(M.edit ? 'Изменения сохранены' : 'Книга добавлена');
      resetForm();
      await refreshManageList();
      if (ROUTES.includes(state.route)) render();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      prog.hidden = true;
    }
  });

  /* ================= Запуск ================= */
  window.addEventListener('hashchange', render);

  (async function init() {
    try {
      const me = await api('GET', '/api/me');
      state.me = me.user;
      state.registration = me.registration;
    } catch {
      state.me = null;
    }
    await render();
    syncStreak();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    (window.requestIdleCallback || ((f) => setTimeout(f, 3000)))(autoDownloadNew);
  })();
})();
