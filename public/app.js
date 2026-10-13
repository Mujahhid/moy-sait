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
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 4500 : 2600);
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
    const pct = b.pages > 0 ? Math.min(100, Math.round((p / b.pages) * 100)) : 0;
    const label = isFinished(b) ? 'Прочитано' : b.pages > 0 ? `стр. ${p} из ${b.pages}` : `стр. ${p}`;
    return `<div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div><div class="pagelabel">${label}</div>`;
  }

  function cardHtml(b) {
    return `<article class="card" data-card="${b.id}">
      <button type="button" class="cover" data-open="${b.id}" aria-label="Читать: ${esc(b.title)}">${coverHtml(b)}</button>
      <button type="button" class="fav ${b.favorite ? 'on' : ''}" data-fav="${b.id}" aria-pressed="${!!b.favorite}"
        aria-label="${b.favorite ? 'Убрать из избранного' : 'В избранное'}">${b.favorite ? '♥' : '♡'}</button>
      <div class="meta" data-open="${b.id}" style="cursor:pointer">
        <h3 dir="auto">${esc(b.title)}</h3>
        ${b.author ? `<p class="author" dir="auto">${esc(b.author)}</p>` : ''}
        <div class="tags"><span class="tag">${LANG[b.language] || ''}</span><span class="tag">${esc(b.section)}</span></div>
        ${progressHtml(b)}
      </div>
    </article>`;
  }

  /* ================= Роутинг и страницы ================= */
  const view = $('#view');

  const ROUTES = ['home', 'publishers', 'catalog', 'favorites'];
  function currentRoute() {
    const h = location.hash.replace(/^#/, '');
    const r = ROUTES.includes(h) ? h : 'home';
    return r === 'home' && state.me ? 'catalog' : r; // «Главная» — только окно входа для гостя
  }

  const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'книга' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'книги' : 'книг');

  function updateNav() {
    $('.tabbar [data-nav=home]').hidden = !!state.me;
    $$('.tabbar [data-nav]').forEach((el) => {
      el.classList.toggle('active', el.dataset.nav === state.route);
      if (el.tagName === 'A') el.setAttribute('aria-current', el.dataset.nav === state.route ? 'page' : 'false');
    });
    $('#nav-profile span').textContent = state.me ? state.me.nick : 'Профиль';
    $('#tab-register').hidden = !state.registration;
  }

  async function render() {
    state.route = currentRoute();
    if (state.me && location.hash !== '#' + state.route && !['publishers', 'favorites'].includes(state.route)) {
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
          <p class="form-error" id="g-error" role="alert"></p>
          <button class="btn primary wide" type="submit" id="g-submit">Войти</button>
        </form>
      </div></section>`;
    const form = $('#g-form');
    $$('[data-gtab]', view).forEach((t) => (t.onclick = () => {
      mode = t.dataset.gtab;
      $$('[data-gtab]', view).forEach((x) => x.classList.toggle('active', x === t));
      $('#g-title').textContent = mode === 'login' ? 'Вход в аккаунт' : 'Создать аккаунт';
      $('#g-submit').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
      form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
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
        state.me = user;
        toast(mode === 'login' ? `С возвращением, ${user.nick}!` : `Добро пожаловать, ${user.nick}!`);
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
    const cta = state.me ? 'Открыть каталог' : 'Войти в читальный зал';

    view.innerHTML = `
      <section class="hero">
        ${ORNAMENT}
        <h1 lang="ar" dir="rtl">كتب العلوم</h1>
        <p class="kicker">Книги знаний</p>
        <p class="lead">Тихая библиотека на русском, арабском и английском. Читайте не спеша.</p>
        <button type="button" class="btn primary" id="cta">${cta}</button>
      </section>
      ${cont.length ? `<section class="shelf"><div class="shelf-head"><h2>Продолжить чтение</h2></div>
        <div class="grid">${cont.map(cardHtml).join('')}</div></section>` : ''}
      ${books.length ? `<section class="shelf"><div class="shelf-head"><h2>Книжная полка</h2>
        <a href="#catalog">Весь каталог →</a></div>${bookcaseHtml(books)}</section>`
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
        title="${esc(b.title)}${b.author ? ' — ' + esc(b.author) : ''}" aria-label="Читать: ${esc(b.title)}">${coverHtml(b)}</button>`).join(''));
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
      title="${esc(b.title)}${b.author ? ' — ' + esc(b.author) : ''}" aria-label="Читать: ${esc(b.title)}">
      <span class="sb-title"${ar} dir="auto">${esc(b.title)}</span></button>`;
  }
  const spinesHtml = (books) => `<div class="spineshelf">${shelfShell(books.map(spineHtml).join(''))}</div>`;
  const spinesBlock = (books) => `<div class="spines-wrap"><h2 class="spines-title">На полке</h2>
    <p class="spines-sub">Нажмите на корешок, чтобы открыть книгу.</p>${spinesHtml(books)}</div>`;

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
  async function renderPublishers() {
    if (state.publisher) {
      const { books } = await api('GET', '/api/books?' + new URLSearchParams({ publisher: state.publisher }));
      view.innerHTML = `<div class="page-head">
          <button type="button" class="back-link" id="pub-back">← Все издательства</button>
          <h1 class="page-title" dir="auto">${esc(state.publisher)}</h1>
          <p class="page-sub">${books.length} ${plural(books.length)}</p></div>
        ${books.length ? `${spinesBlock(books)}<div class="grid">${books.map(cardHtml).join('')}</div>`
          : '<div class="empty">У этого издательства пока нет книг.</div>'}`;
      $('#pub-back').onclick = () => { state.publisher = ''; render(); };
      initShelves();
      return;
    }
    const { publishers } = await api('GET', '/api/publishers');
    view.innerHTML = `<div class="page-head"><h1 class="page-title">Издательства</h1>
        <p class="page-sub">Выберите издательство, чтобы увидеть его книги.</p></div>
      ${publishers.length
        ? `<div class="pub-grid">${publishers.map((p) => `
            <button type="button" class="pub" data-pub="${esc(p.name)}">
              <span class="pub-ico" aria-hidden="true">${esc([...p.name][0].toUpperCase())}</span>
              <span><b dir="auto">${esc(p.name)}</b><span class="sub">${p.count} ${plural(p.count)}</span></span>
            </button>`).join('')}</div>`
        : `<div class="empty">Здесь появятся издательства, когда вы укажете их у книг.${
            state.me?.isAdmin ? '<br><button type="button" class="btn primary" id="first-book">Добавить книгу</button>' : ''}</div>`}`;
    const fb = $('#first-book');
    if (fb) fb.onclick = openManage;
  }

  let searchTimer;
  async function renderCatalog() {
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Каталог</h1></div>
      <div class="search-sticky">
        <div class="search">
          <span class="glass" aria-hidden="true">⌕</span>
          <input id="q" type="text" enterkeyhint="search" autocomplete="off"
            placeholder="Ищите по названию, автору, издательству или теме." value="${esc(state.q)}"
            aria-label="Поиск по каталогу">
          <button type="button" class="clear" id="q-clear" aria-label="Очистить поиск" ${state.q ? '' : 'hidden'}>✕</button>
        </div>
        <p class="result-count" id="q-count" aria-live="polite"></p>
      </div>
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

  async function renderFavorites() {
    if (!state.me) {
      view.innerHTML = `<div class="page-head"><h1 class="page-title">Избранное</h1></div>
        <div class="empty">Войдите, чтобы сохранять книги в избранное.<br>
        <button type="button" class="btn primary" id="fav-login">Войти</button></div>`;
      $('#fav-login').onclick = () => openAuth('login', render);
      return;
    }
    const { books } = await api('GET', '/api/favorites');
    view.innerHTML = `<div class="page-head"><h1 class="page-title">Избранное</h1></div>
      ${books.length
        ? `${spinesBlock(books)}<div class="grid" id="fav-grid">${books.map(cardHtml).join('')}</div>`
        : `<div class="empty">В избранном пока пусто. Нажмите ♡ на обложке книги в каталоге.<br>
           <a class="btn ghost" href="#catalog">Перейти в каталог</a></div>`}`;
    initShelves();
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
      state.publisher = pub.dataset.pub;
      window.scrollTo(0, 0);
      render();
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
      b.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
    });
    if (state.route === 'favorites' && !on) renderFavorites();
    toast(on ? 'Добавлено в избранное' : 'Убрано из избранного');
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
      if (!$('#reader').hidden && !document.fullscreenElement) closeReader();
    }
  });

  /* ================= Вход и регистрация ================= */
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    $$('#m-auth .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
    $('#auth-title').textContent = mode === 'login' ? 'Вход в аккаунт' : 'Создать аккаунт';
    $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
    $('#auth-form [name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
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
      state.me = user;
      form.reset();
      closeModal($('#m-auth'));
      toast(authMode === 'login' ? `С возвращением, ${user.nick}!` : `Добро пожаловать, ${user.nick}!`);
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

  $('#nav-profile').onclick = () => {
    if (!state.me) openAuth('login');
    else openProfile();
  };

  async function openProfile() {
    const body = $('#profile-body');
    body.innerHTML = '<p class="muted">Загрузка…</p>';
    openModal('m-profile');
    let stats = { reading: 0, finished: 0, favorites: 0 };
    let items = [];
    try {
      [stats, { items }] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/progress')]);
    } catch (e) {
      body.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
      return;
    }
    const cont = items.map((i) => i.book).filter((b) => !isFinished(b)).slice(0, 4);
    body.innerHTML = `
      <div class="profile-head">
        <div class="avatar">${esc(state.me.nick[0])}</div>
        <div><b>${esc(state.me.nick)}</b>${state.me.isAdmin ? '<span class="badge">админ</span>' : ''}
          <div class="muted small">Прогресс чтения хранится в аккаунте</div></div>
      </div>
      <div class="stats">
        <div class="stat"><b>${stats.reading}</b><span>читаю</span></div>
        <div class="stat"><b>${stats.finished}</b><span>прочитано</span></div>
        <div class="stat"><b>${stats.favorites}</b><span>в избранном</span></div>
      </div>
      ${cont.length ? `<h4>Продолжить чтение</h4><div class="cont">${cont.map((b) => `
        <button type="button" class="cont-item" data-continue="${b.id}">${thumbHtml(b)}
          <span class="txt"><b dir="auto">${esc(b.title)}</b>
          <span class="sub">${b.pages > 0 ? `стр. ${b.progress.page} из ${b.pages}` : `стр. ${b.progress.page}`}</span></span>
        </button>`).join('')}</div>` : ''}
      <div class="profile-actions">
        ${state.me.isAdmin ? '<button type="button" class="btn primary" id="p-manage">Управление библиотекой</button>' : ''}
        <button type="button" class="btn ghost" id="p-pass">Сменить пароль</button>
        <button type="button" class="btn ghost" id="p-logout">Выйти</button>
      </div>
      <form class="pw-form" id="pw-form" hidden>
        <label class="field">Текущий пароль<input name="old" type="password" autocomplete="current-password" required></label>
        <label class="field">Новый пароль (от 6 символов)<input name="new" type="password" autocomplete="new-password" minlength="6" required></label>
        <p class="form-error" id="pw-error"></p><p class="ok-msg" id="pw-ok"></p>
        <button class="btn primary" type="submit">Сохранить пароль</button>
      </form>`;

    $$('[data-continue]', body).forEach((b) => (b.onclick = () => {
      closeModal($('#m-profile'));
      openReader(Number(b.dataset.continue));
    }));
    const pm = $('#p-manage');
    if (pm) pm.onclick = () => { closeModal($('#m-profile')); openManage(); };
    $('#p-pass').onclick = () => { $('#pw-form').hidden = !$('#pw-form').hidden; };
    $('#p-logout').onclick = async () => {
      try { await api('POST', '/api/logout'); } catch { /* всё равно выходим */ }
      state.me = null;
      closeModal($('#m-profile'));
      toast('Вы вышли из аккаунта');
      history.replaceState(null, '', '#home');
      render();
    };
    $('#pw-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      $('#pw-error').textContent = '';
      $('#pw-ok').textContent = '';
      try {
        await api('POST', '/api/password', { oldPassword: f.old.value, newPassword: f.new.value });
        f.reset();
        $('#pw-ok').textContent = 'Пароль изменён. На других устройствах потребуется войти заново.';
      } catch (err) {
        $('#pw-error').textContent = err.message;
      }
    });
  }

  /* ================= Читалка (pdf.js) ================= */
  const R = {
    doc: null, loading: null, session: 0, book: null, page: 1, total: 0, mode: 'fit', zoom: 1, scale: 1,
    task: null, token: 0, saveTimer: null, dirty: false,
    night: localStorage.getItem('reader_night') === '1',
  };
  const reader = $('#reader');
  const stage = $('#r-stage');
  const canvas = $('#r-canvas');
  const pageInput = $('#r-page');

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
    localStorage.setItem('reader_night', on ? '1' : '0');
  }

  function showLoading(msg, isErr = false) {
    const l = $('#r-loading');
    l.textContent = msg || '';
    l.hidden = !msg;
    l.classList.toggle('err', isErr);
  }

  async function openReader(id) {
    // модуль чтения и данные книги грузим одновременно
    let pdfjsLib, book;
    try {
      [pdfjsLib, { book }] = await Promise.all([loadPdfjs(), api('GET', `/api/books/${id}`)]);
    } catch (e) {
      toast(e instanceof TypeError ? 'Не удалось загрузить модуль чтения (pdf.js). Проверьте соединение.' : e.message, true);
      return;
    }
    Object.assign(R, { book, doc: null, page: 1, total: book.pages || 0, task: null });
    R.token++;
    const session = ++R.session;
    if (R.loading) { try { R.loading.destroy(); } catch { /* ok */ } R.loading = null; }
    setNight(R.night);
    $('#r-title').textContent = book.title;
    $('#r-title').dir = 'auto';
    pageInput.value = '';
    $('#r-total').textContent = '';
    canvas.width = canvas.height = 0;
    canvas.style.width = canvas.style.height = '0';
    showLoading('Открываем книгу…');
    $('#r-prev').disabled = $('#r-next').disabled = pageInput.disabled = true; // пока книга грузится — листать нельзя
    reader.hidden = false;
    document.body.classList.add('no-scroll');
    history.pushState({ reader: true }, '');
    stage.focus({ preventScroll: true });

    let loadingTask = null;
    try {
      loadingTask = pdfjsLib.getDocument({ ...PDF_OPTS, url: `/api/books/${id}/pdf`, withCredentials: true });
      const doc = await loadingTask.promise;
      if (session !== R.session || reader.hidden) { loadingTask.destroy(); return; }
      R.loading = loadingTask;
      R.doc = doc;
      R.total = doc.numPages;
      const saved = book.progress?.page || Number(localStorage.getItem(`kp_${id}`)) || 1;
      R.page = Math.min(Math.max(1, saved), R.total);
      pageInput.max = R.total;
      $('#r-total').textContent = `/ ${R.total}`;
      await goTo(R.page, true);
    } catch (e) {
      if (loadingTask && R.loading !== loadingTask) { try { loadingTask.destroy(); } catch { /* ok */ } }
      if (session !== R.session || reader.hidden) return;
      showLoading(
        e?.name === 'PasswordException' ? 'PDF защищён паролем — открыть его нельзя.'
          : e?.status === 401 || /401/.test(e?.message || '') ? 'Сессия истекла — войдите снова.'
          : 'Не удалось открыть книгу. Попробуйте позже.',
        true
      );
    }
  }

  async function renderCurrent() {
    const doc = R.doc;
    if (!doc) return;
    const myToken = ++R.token;
    if (R.task) { try { R.task.cancel(); } catch { /* уже завершено */ } }
    let page;
    try {
      page = await doc.getPage(R.page);
    } catch { return; }
    if (myToken !== R.token) return;

    const base = page.getViewport({ scale: 1 });
    const avail = Math.max(200, stage.clientWidth - 28);
    // на широком экране вписываем страницу целиком, на телефоне — по ширине
    const availH = Math.max(200, stage.clientHeight - 28);
    const wide = stage.clientWidth >= 700 && stage.clientWidth > stage.clientHeight;
    const fitScale = wide ? Math.min(avail / base.width, availH / base.height) : avail / base.width;
    const scale = R.mode === 'fit' ? Math.min(fitScale, 3) : R.zoom;
    R.scale = scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = page.getViewport({ scale: scale * dpr });

    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.floor(vp.width));
    off.height = Math.max(1, Math.floor(vp.height));
    const task = page.render({ canvasContext: off.getContext('2d'), viewport: vp });
    R.task = task;
    try {
      await task.promise;
    } catch (e) {
      if (e?.name === 'RenderingCancelledException') return;
      if (myToken === R.token) showLoading('Не удалось отобразить страницу.', true);
      return;
    }
    if (myToken !== R.token) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.style.width = `${off.width / dpr}px`;
    canvas.style.height = `${off.height / dpr}px`;
    canvas.getContext('2d').drawImage(off, 0, 0);
    showLoading('');
    if (R.page < R.total) doc.getPage(R.page + 1).catch(() => {}); // прогреваем следующую страницу
  }

  function updateReaderUi() {
    pageInput.value = R.page;
    pageInput.disabled = false;
    $('#r-prev').disabled = R.page <= 1;
    $('#r-next').disabled = R.page >= R.total;
    $('#r-bar').style.width = R.total ? `${(R.page / R.total) * 100}%` : '0';
    $('#r-fit').classList.toggle('active', R.mode === 'fit');
  }

  async function goTo(n, initial = false) {
    if (!R.doc) return;
    n = Math.min(Math.max(1, Math.round(Number(n) || 1)), R.total);
    if (n === R.page && !initial) { updateReaderUi(); return; }
    R.page = n;
    updateReaderUi();
    stage.scrollTo(0, 0);
    if (!initial) scheduleSave();
    await renderCurrent();
  }

  function scheduleSave() {
    if (!R.book) return;
    localStorage.setItem(`kp_${R.book.id}`, String(R.page));
    R.dirty = true;
    clearTimeout(R.saveTimer);
    R.saveTimer = setTimeout(flushProgress, 700);
  }

  function flushProgress() {
    clearTimeout(R.saveTimer);
    if (!R.dirty || !R.book || !state.me) return;
    R.dirty = false;
    const id = R.book.id;
    const page = R.page;
    fetch(`/api/progress/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ page }),
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
    renderCurrent();
  }

  function closeReader() {
    if (history.state && history.state.reader) history.back();
    else doCloseReader();
  }

  function doCloseReader() {
    if (reader.hidden) return;
    flushProgress();
    R.token++;
    if (R.task) { try { R.task.cancel(); } catch { /* ok */ } }
    R.session++;
    if (R.loading) { try { R.loading.destroy(); } catch { /* ok */ } }
    R.loading = null;
    R.doc = null;
    R.book = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    reader.hidden = true;
    canvas.width = canvas.height = 0;
    if (!$$('.modal').some((m) => !m.hidden)) document.body.classList.remove('no-scroll');
    if (ROUTES.includes(state.route)) render(); // обновить прогресс на карточках
  }

  window.addEventListener('popstate', () => { if (!reader.hidden) doCloseReader(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushProgress(); });
  window.addEventListener('pagehide', flushProgress);

  $('#r-close').onclick = closeReader;
  $('#r-prev').onclick = () => goTo(R.page - 1);
  $('#r-next').onclick = () => goTo(R.page + 1);
  $('#r-zoom-in').onclick = () => zoomBy(1.2);
  $('#r-zoom-out').onclick = () => zoomBy(1 / 1.2);
  $('#r-fit').onclick = () => { R.mode = 'fit'; updateReaderUi(); renderCurrent(); };
  $('#r-night').onclick = () => setNight(!R.night);
  pageInput.addEventListener('change', () => goTo(pageInput.value));
  pageInput.addEventListener('focus', () => pageInput.select());

  const fsBtn = $('#r-full');
  if (!(document.fullscreenEnabled || reader.webkitRequestFullscreen)) fsBtn.hidden = true;
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else (reader.requestFullscreen || reader.webkitRequestFullscreen).call(reader);
  };
  document.addEventListener('fullscreenchange', () => {
    if (!reader.hidden && R.mode === 'fit') renderCurrent();
  });

  document.addEventListener('keydown', (e) => {
    if (reader.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches('input, textarea, select')) return;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': goTo(R.page + 1); break;
      case 'ArrowLeft': case 'PageUp': goTo(R.page - 1); break;
      case 'Home': goTo(1); break;
      case 'End': goTo(R.total); break;
      case '+': case '=': zoomBy(1.2); break;
      case '-': zoomBy(1 / 1.2); break;
      default: return;
    }
    e.preventDefault();
  });

  let rzTimer;
  window.addEventListener('resize', () => {
    if (reader.hidden || R.mode !== 'fit') return;
    clearTimeout(rzTimer);
    rzTimer = setTimeout(renderCurrent, 200);
  });

  // свайп для листания (когда страница целиком влезает по ширине)
  let touch = null;
  stage.addEventListener('touchstart', (e) => {
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!touch || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 50 || stage.scrollWidth > stage.clientWidth + 2) return;
    goTo(R.page + (dx < 0 ? 1 : -1));
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
  })();
})();
