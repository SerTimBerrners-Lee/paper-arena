// screens.mjs — the app shell around the game (mobile-app styled): a phone frame
// with a top app-bar, a body that swaps panels (menu / leaderboard / profile /
// death), and a bottom tab bar. Fully localized (RU/EN/UK) with live switching;
// Settings (language + version) live in the profile. Currency is the virtual ◇.
import { api, getToken, setToken, fmtMoney, APP_VERSION } from '../net/api.mjs';
import { t, getLang, setLang, LANGS, onLangChange } from '../i18n.mjs';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reasonText = (reason) => {
  const k = `reason.${reason || ''}`;
  const r = t(k);
  return r === k ? t('reason.default') : r;
};

// One cohesive line-icon set (24px viewBox, currentColor) — consistent cyberpunk look.
const ICON = {
  ranks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V13M12 21V4M18 21V15"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg>',
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c.7-3.4 3.4-5 6.5-5s5.8 1.6 6.5 5"/></svg>',
};
const CARD_ICON = {
  wager: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M16 3l13 7.5v11L16 29 3 21.5v-11z"/><path d="M16 3v26M3 10.5l13 7.5 13-7.5"/></svg>',
  free: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6.5" y="10" width="19" height="14" rx="3.5"/><path d="M16 4v6M11 28v1.8M21 28v1.8"/><circle cx="12.5" cy="17" r="1.7" fill="currentColor" stroke="none"/><circle cx="19.5" cy="17" r="1.7" fill="currentColor" stroke="none"/></svg>',
  soon: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M16 8v16M8 16h16"/></svg>',
};

export function createScreens(handlers = {}) {
  const root = el('div', 'screens');
  root.hidden = true;

  const frame = el('div', 'app-frame');
  const bar = el('header', 'app-bar');
  const brand = el('div', 'app-brand', 'PAPER<span>//</span>ARENA');
  const balanceChip = el('button', 'bal-chip', `<span>${t('common.balance')}</span><strong>${fmtMoney(0)}</strong>`);
  balanceChip.addEventListener('click', () => showTopup());
  bar.append(brand, balanceChip);

  const body = el('div', 'app-body');
  const panels = {};
  for (const id of ['menu', 'leaderboard', 'profile', 'referrals', 'settings', 'topup', 'pubprofile', 'death']) {
    const p = el('section', 'screen');
    p.hidden = true;
    panels[id] = p;
    body.appendChild(p);
  }

  const nav = el('nav', 'app-nav');
  const navDefs = [['leaderboard', ICON.ranks, 'nav.ranks'], ['menu', ICON.play, 'nav.play'], ['profile', ICON.profile, 'nav.me']];
  const navBtns = {};
  for (const [tab, glyph, key] of navDefs) {
    const b = el('button', 'nav-tab', `<i>${glyph}</i><span>${t(key)}</span>`);
    b.dataset.tab = tab; b.dataset.key = key;
    b.addEventListener('click', () => {
      if (tab === 'menu') showMenu();
      else if (tab === 'leaderboard') showLeaderboard('earned');
      else showProfile();
    });
    navBtns[tab] = b;
    nav.appendChild(b);
  }

  frame.append(bar, body, nav);
  root.appendChild(frame);

  const flash = el('div', 'screen-flash');
  flash.hidden = true;
  root.appendChild(flash);
  document.body.appendChild(root);
  let flashTimer = null;

  let user = null;
  let config = { stakeCents: 20, minHumans: 2 };
  let lbMetric = 'earned';
  // referral code from the invite link (?ref=) or a Telegram start_param
  const refCode = (() => {
    try {
      const q = new URLSearchParams(location.search).get('ref');
      const tgp = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe
        && window.Telegram.WebApp.initDataUnsafe.start_param;
      return q || tgp || null;
    } catch { return null; }
  })();
  let lastDeath = null;
  let rerender = renderMenu; // re-render hook for live language switching

  function updateBalanceChip() {
    balanceChip.querySelector('span').textContent = t('common.balance');
    if (user) balanceChip.querySelector('strong').textContent = fmtMoney(user.balanceCents);
  }
  function applyNavLabels() {
    for (const tab of Object.keys(navBtns)) navBtns[tab].querySelector('span').textContent = t(navBtns[tab].dataset.key);
  }

  const THEMES = ['dark', 'light'];
  const getTheme = () => localStorage.getItem('paper_theme') || 'dark';
  const applyTheme = (th) => { document.documentElement.dataset.theme = THEMES.includes(th) ? th : 'dark'; };
  const setTheme = (th) => { localStorage.setItem('paper_theme', th); applyTheme(th); rerender(); };

  function show(which) {
    for (const k of Object.keys(panels)) panels[k].hidden = k !== which;
    const authed = !!user;
    const chrome = authed && which !== 'death';
    nav.hidden = !chrome;
    balanceChip.hidden = !chrome;
    for (const tab of Object.keys(navBtns)) navBtns[tab].classList.toggle('active', tab === which);
    updateBalanceChip();
    root.hidden = false;
    root.dataset.open = which;
  }
  function hideAll() { root.hidden = true; root.dataset.open = ''; }

  function toast(msg) {
    flash.textContent = msg;
    flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.hidden = true; }, 2600);
  }

  // celebratory burst over the whole frame (on a profitable life)
  function confettiBurst() {
    const colors = ['#00e5ff', '#ff2bd6', '#f7ee12', '#36f0ff', '#14d6a0'];
    for (let i = 0; i < 70; i += 1) {
      const c = el('div', 'confetti');
      c.style.left = `${4 + (i * 37) % 92}%`;
      c.style.background = colors[i % colors.length];
      c.style.setProperty('--x', `${((i * 53) % 120) - 60}vw`);
      c.style.setProperty('--r', `${((i * 97) % 760) - 380}deg`);
      c.style.setProperty('--d', `${950 + (i * 53) % 850}ms`);
      c.style.animationDelay = `${(i % 12) * 22}ms`;
      frame.appendChild(c);
      setTimeout(() => c.remove(), 2300);
    }
  }

  const walletBadge = (balanceCents, frozenCents) =>
    `<div class="wallet-badge"><span>${t('common.balance')}</span><strong>${fmtMoney(balanceCents)}</strong>${
      frozenCents ? `<em>${t('common.staked', { amount: fmtMoney(frozenCents) })}</em>` : ''}</div>`;

  // ── main menu ────────────────────────────────────────────────────────────────
  function renderMenu() {
    rerender = renderMenu;
    const p = panels.menu;
    p.innerHTML = '';

    if (!user) {
      p.classList.remove('menu-arenas');
      p.appendChild(el('div', 'hero', `<div class="hero-glyph">${CARD_ICON.wager}</div>`));
      p.appendChild(el('h1', 'brand', 'PAPER<span>//</span>ARENA'));
      p.appendChild(el('p', 'sub', t('login.tagline')));
      const form = el('div', 'login');
      const input = el('input', 'text-input');
      input.maxLength = 16; input.placeholder = t('login.placeholder');
      input.value = localStorage.getItem('paper_name') || '';
      const btn = el('button', 'btn-primary', t('login.enter'));
      const go = async () => {
        const name = input.value.trim() || 'Guest';
        localStorage.setItem('paper_name', name);
        btn.disabled = true; btn.textContent = t('login.connecting');
        try { const r = await api.loginDev(name, refCode); setToken(r.token); user = r.user; renderMenu(); show('menu'); }
        catch { btn.disabled = false; btn.textContent = t('login.enter'); toast(t('toast.loginFailed')); }
      };
      btn.addEventListener('click', go);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      form.append(input, btn);
      p.appendChild(form);
      return;
    }

    p.classList.add('menu-arenas'); // full-bleed swipe cards

    const stake = config.stakeCents;
    const canAfford = user.balanceCents >= stake;

    // Swipeable arena cards: PAID (default) → swipe → FREE → COMING SOON.
    const carousel = el('div', 'carousel');
    const cardWager = el('div', 'arena-card paid',
      `<div class="card-art">${CARD_ICON.wager}</div><div class="card-title">PAPER<span>//</span>ARENA</div>`
      + `<div class="card-sub">${t('card.paidSub', { stake: fmtMoney(stake) })}</div>`);
    const playW = el('button', 'btn-primary big play', t('menu.play'));
    playW.disabled = !canAfford;
    playW.addEventListener('click', () => handlers.onPlay && handlers.onPlay('wager'));
    cardWager.appendChild(playW);
    if (!canAfford) cardWager.appendChild(el('p', 'hint warn', t('menu.notEnough')));

    const pracBal = user.practiceBalanceCents ?? 0;
    const cardFree = el('div', 'arena-card free',
      `<div class="card-art">${CARD_ICON.free}</div><div class="card-title">${t('card.freeTitle')}</div>`
      + `<div class="card-sub">${t('card.practice')} · <b class="prac-bal">${fmtMoney(pracBal)}</b></div>`);
    const playF = el('button', 'btn-primary big play', t('menu.play'));
    playF.disabled = pracBal < stake;
    playF.addEventListener('click', () => handlers.onPlay && handlers.onPlay('free'));
    cardFree.appendChild(playF);
    const refreshF = el('button', 'btn-ghost refresh', t('menu.refreshPractice'));
    refreshF.addEventListener('click', async () => {
      try {
        const w = await api.refreshPractice();
        if (user) user.practiceBalanceCents = w.practiceBalanceCents;
        cardFree.querySelector('.prac-bal').textContent = fmtMoney(w.practiceBalanceCents);
        playF.disabled = w.practiceBalanceCents < stake;
        toast(t('toast.refreshed'));
      } catch {}
    });
    cardFree.appendChild(refreshF);

    const cardSoon = el('div', 'arena-card soon',
      `<div class="card-art">${CARD_ICON.soon}</div><div class="card-title">${t('card.soonTitle')}</div>`
      + `<div class="card-sub">${t('card.soon')}</div>`);

    carousel.append(cardWager, cardFree, cardSoon);
    p.appendChild(carousel);

    const dots = el('div', 'dots');
    const n = 3;
    for (let i = 0; i < n; i += 1) {
      const d = el('button', `dot${i === 0 ? ' active' : ''}`);
      d.addEventListener('click', () => carousel.scrollTo({ left: carousel.clientWidth * i, behavior: 'smooth' }));
      dots.appendChild(d);
    }
    carousel.addEventListener('scroll', () => {
      const idx = Math.round(carousel.scrollLeft / Math.max(1, carousel.clientWidth));
      [...dots.children].forEach((d, i) => d.classList.toggle('active', i === idx));
    });
    p.appendChild(dots);
  }

  async function showMenu() {
    if (getToken()) { try { user = await api.profile(); } catch { setToken(null); user = null; } }
    renderMenu();
    show('menu');
  }

  // ── leaderboard ──────────────────────────────────────────────────────────────
  async function showLeaderboard(metric = 'earned') {
    lbMetric = metric;
    rerender = () => showLeaderboard(lbMetric);
    show('leaderboard');
    const p = panels.leaderboard;
    p.innerHTML = '';
    p.appendChild(el('h1', null, t('lb.title')));
    const tabs = el('div', 'tabs');
    for (const m of [['earned', t('lb.earned')], ['referrals', t('lb.referrals')]]) {
      const tb = el('button', m[0] === metric ? 'active' : '', m[1]);
      tb.addEventListener('click', () => showLeaderboard(m[0]));
      tabs.appendChild(tb);
    }
    p.appendChild(tabs);
    const list = el('ol', 'lb-list', `<li class="lb-empty">${t('lb.loading')}</li>`);
    p.appendChild(list);
    try {
      const { entries } = await api.leaderboard(metric);
      list.innerHTML = '';
      if (!entries.length) { list.appendChild(el('li', 'lb-empty', t('lb.empty'))); return; }
      for (const e of entries) {
        const val = metric === 'referrals' ? e.referralEarnedCents : e.earnedCents;
        const me = user && e.id === user.id ? ' me' : '';
        const row = el('li', `lb-row tap${me}`,
          `<span class="rank">${e.rank}</span><span class="who">${escapeHtml(e.username)}</span>`
          + `<span class="kd">${e.kills}/${e.deaths}</span><span class="amt">${fmtMoney(val)}</span>`);
        row.addEventListener('click', () => showPublicProfile(e.id));
        list.appendChild(row);
      }
    } catch { list.innerHTML = `<li class="lb-empty">${t('lb.error')}</li>`; }
  }

  // ── profile (+ settings) ──────────────────────────────────────────────────────
  function renderProfile() {
    rerender = renderProfile;
    const p = panels.profile;
    p.innerHTML = '';
    if (!user) { p.appendChild(el('h1', null, t('profile.title'))); p.appendChild(el('p', 'sub', t('profile.signInFirst'))); return; }
    updateBalanceChip();
    const s = user.stats;
    p.appendChild(el('div', 'avatar', escapeHtml((user.username || '?')[0].toUpperCase())));
    p.appendChild(el('div', 'greet big', `<b>${escapeHtml(user.username)}</b>`));
    p.appendChild(el('div', 'wallet-wrap', walletBadge(user.balanceCents, user.frozenCents)));
    const grid = el('div', 'stat-grid big');
    const stats = [
      ['stat.games', s.games], ['stat.kills', s.kills], ['stat.deaths', s.deaths], ['stat.kd', s.kd],
      ['stat.bestArea', `${(s.maxAreaCells / 12100 * 100).toFixed(1)}%`], ['stat.bestStreak', s.bestStreak],
      ['stat.earned', fmtMoney(s.totalEarnedCents)], ['stat.net', fmtMoney(s.netProfitCents)],
    ];
    for (const [k, v] of stats) grid.appendChild(el('div', 'stat', `<span>${t(k)}</span><strong>${v}</strong>`));
    p.appendChild(grid);

    const refBtn = el('button', 'btn', t('profile.referrals'));
    refBtn.addEventListener('click', () => showReferrals());
    p.appendChild(refBtn);
    const setBtn = el('button', 'btn', t('settings.title'));
    setBtn.addEventListener('click', () => showSettings());
    p.appendChild(setBtn);
  }
  async function showProfile() {
    show('profile');
    panels.profile.innerHTML = `<h1>${t('profile.title')}</h1><p class="sub">${t('lb.loading')}</p>`;
    try { user = await api.profile(); } catch {}
    renderProfile();
  }

  // ── settings (opened from the Profile tab) ──────────────────────────────────
  function renderSettings() {
    rerender = renderSettings;
    const p = panels.settings;
    p.innerHTML = '';
    p.appendChild(el('h1', null, t('settings.title')));

    const langWrap = el('div', 'settings');
    langWrap.appendChild(el('div', 'settings-title', t('settings.language')));
    const langBtns = el('div', 'lang-btns');
    for (const [code, label] of LANGS) {
      const lb = el('button', `lang-btn${getLang() === code ? ' active' : ''}`, label);
      lb.addEventListener('click', () => setLang(code));
      langBtns.appendChild(lb);
    }
    langWrap.appendChild(langBtns);
    p.appendChild(langWrap);

    const themeWrap = el('div', 'settings');
    themeWrap.appendChild(el('div', 'settings-title', t('settings.theme')));
    const themeBtns = el('div', 'lang-btns');
    for (const th of THEMES) {
      const tb = el('button', `lang-btn${getTheme() === th ? ' active' : ''}`, t(`theme.${th}`));
      tb.addEventListener('click', () => setTheme(th));
      themeBtns.appendChild(tb);
    }
    themeWrap.appendChild(themeBtns);
    p.appendChild(themeWrap);

    const foot = el('div', 'settings');
    const verRow = el('div', 'set-row');
    verRow.appendChild(el('span', 'set-label', t('settings.version')));
    verRow.appendChild(el('span', 'set-value', APP_VERSION));
    foot.appendChild(verRow);
    p.appendChild(foot);
    const out = el('button', 'btn btn-danger', t('common.signOut'));
    out.addEventListener('click', () => { setToken(null); user = null; showMenu(); });
    p.appendChild(out);

    const back = el('button', 'btn', t('common.back'));
    back.addEventListener('click', showProfile);
    p.appendChild(back);
  }
  function showSettings() { show('settings'); renderSettings(); }

  // ── referrals (separate page: invite link + summary + list) ─────────────────
  async function showReferrals() {
    show('referrals');
    const p = panels.referrals;
    p.innerHTML = `<h1>${t('profile.referrals')}</h1><p class="sub">${t('lb.loading')}</p>`;
    let data;
    try { data = await api.referrals(); }
    catch { p.innerHTML = `<h1>${t('profile.referrals')}</h1><p class="sub">${t('lb.error')}</p>`; return; }
    rerender = () => showReferrals();
    p.innerHTML = '';
    p.appendChild(el('h1', null, t('profile.referrals')));
    p.appendChild(el('p', 'ref-invite', t('ref.invite')));
    const link = `${location.origin}/?ref=${data.code}`;
    const copy = el('button', 'btn-primary', t('ref.copy'));
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); } catch {}
      toast(t('ref.copied'));
    });
    p.appendChild(copy);
    const sg = el('div', 'stat-grid big');
    sg.appendChild(el('div', 'stat', `<span>${t('ref.count')}</span><strong>${data.referrals}</strong>`));
    sg.appendChild(el('div', 'stat', `<span>${t('ref.earned')}</span><strong>${fmtMoney(data.earnedCents)}</strong>`));
    p.appendChild(sg);
    if (data.list && data.list.length) {
      const list = el('ol', 'lb-list');
      data.list.forEach((r, i) => list.appendChild(el('li', 'lb-row',
        `<span class="rank">${i + 1}</span><span class="who">${escapeHtml(r.username)}</span>`
        + `<span class="kd">${r.games} ${t('stat.games')}</span><span class="amt">${r.kills} ${t('stat.kills')}</span>`)));
      p.appendChild(list);
    } else {
      p.appendChild(el('p', 'hint', t('ref.empty')));
    }
    const top = el('button', 'btn', t('ref.top'));
    top.addEventListener('click', () => showLeaderboard('referrals'));
    p.appendChild(top);
    const back = el('button', 'btn', t('common.back'));
    back.addEventListener('click', showProfile);
    p.appendChild(back);
  }

  // ── top-up (deposit) — stub for now; on-chain TON later, cards after ─────────
  function showTopup() {
    show('topup');
    rerender = showTopup;
    const p = panels.topup;
    p.innerHTML = '';
    p.appendChild(el('h1', null, t('topup.title')));
    p.appendChild(el('div', 'hero', `<div class="hero-glyph">${CARD_ICON.wager}</div>`));
    p.appendChild(el('div', 'wallet-wrap', walletBadge(user ? user.balanceCents : 0, user ? user.frozenCents : 0)));
    p.appendChild(el('p', 'sub', t('topup.soon')));
    p.appendChild(el('p', 'hint', t('topup.note')));
    const back = el('button', 'btn', t('common.back'));
    back.addEventListener('click', showMenu);
    p.appendChild(back);
  }

  // ── public profile (from a leaderboard tap) — stats only, NO balance ────────
  async function showPublicProfile(id) {
    show('pubprofile');
    const p = panels.pubprofile;
    p.innerHTML = `<h1>${t('profile.title')}</h1><p class="sub">${t('lb.loading')}</p>`;
    let u;
    try { u = await api.profile(id); }
    catch { p.innerHTML = `<h1>${t('profile.title')}</h1><p class="sub">${t('lb.error')}</p>`; return; }
    rerender = () => showPublicProfile(id);
    const s = u.stats;
    p.innerHTML = '';
    p.appendChild(el('div', 'avatar', escapeHtml((u.username || '?')[0].toUpperCase())));
    p.appendChild(el('div', 'greet big', `<b>${escapeHtml(u.username)}</b>`));
    const grid = el('div', 'stat-grid big');
    const stats = [
      ['stat.games', s.games], ['stat.kills', s.kills], ['stat.deaths', s.deaths], ['stat.kd', s.kd],
      ['stat.bestArea', `${(s.maxAreaCells / 12100 * 100).toFixed(1)}%`], ['stat.bestStreak', s.bestStreak],
      ['stat.earned', fmtMoney(s.totalEarnedCents)], ['stat.net', fmtMoney(s.netProfitCents)],
    ];
    for (const [k, v] of stats) grid.appendChild(el('div', 'stat', `<span>${t(k)}</span><strong>${v}</strong>`));
    p.appendChild(grid);
    const back = el('button', 'btn', t('common.back'));
    back.addEventListener('click', () => showLeaderboard(lbMetric));
    p.appendChild(back);
  }

  // ── death screen ─────────────────────────────────────────────────────────────
  function showDeath(d) {
    lastDeath = d;
    rerender = () => showDeath(lastDeath);
    show('death');
    const p = panels.death;
    p.innerHTML = '';
    p.appendChild(el('h1', 'death-title', t('death.title')));
    p.appendChild(el('p', 'death-reason', reasonText(d.reason)));
    const grid = el('div', 'stat-grid');
    for (const [k, v] of [
      ['death.territory', `${((d.areaPct || 0) * 100).toFixed(1)}%`],
      ['death.kills', d.kills || 0],
      ['death.survived', fmtTime(d.durationMs || 0)],
    ]) grid.appendChild(el('div', 'stat', `<span>${t(k)}</span><strong>${v}</strong>`));
    p.appendChild(grid);

    const isWager = d.mode === 'wager';
    const isPractice = !!d.practice;
    const stake = config.stakeCents;

    if (isWager || isPractice) {
      const earned = d.earnedCents || 0; // always framed positively — never show a loss
      p.appendChild(el('div', `econ-result win${isPractice ? ' practice' : ''}`,
        `<span class="er-label">${t('death.earned')}</span>`
        + (isPractice ? `<span class="er-tag">${t('death.practice')}</span>` : '')
        + `<strong class="er-net"><span class="sign">+</span>${fmtMoney(earned)}</strong>`));
      if (isWager && d.wallet) {
        user = { ...(user || {}), balanceCents: d.wallet.balanceCents, frozenCents: d.wallet.frozenCents };
        p.appendChild(el('div', 'wallet-wrap', walletBadge(d.wallet.balanceCents, d.wallet.frozenCents)));
      } else if (isPractice && d.practiceBalanceCents != null) {
        if (user) user.practiceBalanceCents = d.practiceBalanceCents;
        p.appendChild(el('div', 'wallet-wrap',
          `<div class="wallet-badge practice"><span>${t('card.practice')}</span><strong>${fmtMoney(d.practiceBalanceCents)}</strong></div>`));
      }
      if (earned > 0) confettiBurst();
    }

    const bal = isPractice ? (d.practiceBalanceCents ?? 0) : (user ? user.balanceCents : 0);
    const canAfford = (!isWager && !isPractice) || bal >= stake;
    const again = el('button', 'btn-primary', isWager ? `${t('death.respawn')} · ${fmtMoney(stake)}` : t('death.playAgain'));
    again.disabled = !canAfford;
    again.addEventListener('click', () => handlers.onRespawn && handlers.onRespawn());
    p.appendChild(again);
    if (!canAfford) {
      if (isPractice) {
        const rf = el('button', 'btn', t('menu.refreshPractice'));
        rf.addEventListener('click', async () => {
          try { const w = await api.refreshPractice(); showDeath({ ...d, practiceBalanceCents: w.practiceBalanceCents }); } catch {}
        });
        p.appendChild(rf);
      } else {
        p.appendChild(el('p', 'hint warn', t('death.topUp')));
      }
    }
    const menu = el('button', 'btn', t('death.menu'));
    menu.addEventListener('click', () => handlers.onLeave && handlers.onLeave());
    p.appendChild(menu);
  }

  function setWallet(w) {
    if (!w || !user) return;
    user.balanceCents = w.balanceCents;
    user.frozenCents = w.frozenCents;
    updateBalanceChip();
  }

  onLangChange(() => { applyNavLabels(); updateBalanceChip(); if (!root.hidden) rerender(); });

  async function bootstrap() {
    applyTheme(getTheme());
    try { config = await api.config(); } catch {}
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) { try { tg.ready(); tg.expand(); } catch {} }
    if (!getToken() && tg && tg.initData) {
      try { const r = await api.loginTelegram(tg.initData, refCode); setToken(r.token); user = r.user; } catch {}
    }
    if (getToken() && !user) { try { user = await api.profile(); } catch { setToken(null); } }
    await showMenu();
  }

  return {
    bootstrap, showMenu, showDeath, enterGame: hideAll, setWallet, toast,
    getUser: () => user,
    isOpen: () => !root.hidden,
  };
}
