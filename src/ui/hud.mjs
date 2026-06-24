// hud.mjs — in-game top bar: Territory, Kills (frags this life) and Earned (◇ won
// this life). A floating "+◇" pops on each kill. Plus the compact corner
// scoreboard (rank · name · kills · earned) and the waiting banner. Localized.
import { fmtMoney } from '../net/api.mjs';
import { t, onLangChange } from '../i18n.mjs';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money0 = (cents) => `◇ ${((cents || 0) / 100).toFixed(2)}`; // thin-space gap (matches fmtMoney)

export function createHud({ onMenu } = {}) {
  const $ = (id) => document.getElementById(id);
  const territoryEl = $('territory-value');
  const killsEl = $('kills-value');
  const earnedEl = $('earned-value');
  const earnMetric = $('earn-metric');
  const liveEl = $('live-status');
  const menuBtn = $('restart-button');
  const scoreboardEl = $('scoreboard');
  const floatsEl = $('kill-floats');
  const lblTerritory = $('lbl-territory');
  const lblKills = $('lbl-kills');
  const lblEarned = $('lbl-earned');

  let banner = $('waiting-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'waiting-banner';
    banner.className = 'waiting-banner';
    banner.hidden = true;
    ($('game-shell') || document.body).appendChild(banner);
  }

  if (menuBtn && onMenu) menuBtn.addEventListener('click', () => onMenu());

  let mode = 'wager';
  let kills = 0;
  let earnedCents = 0;
  let lastBoard = null;
  let lastYou = -1;
  let waiting = null;

  function applyLang() {
    if (lblTerritory) lblTerritory.textContent = t('hud.territory');
    if (lblKills) lblKills.textContent = t('hud.kills');
    if (lblEarned) lblEarned.textContent = t('hud.earned');
    if (menuBtn) menuBtn.textContent = t('hud.menu');
    if (waiting) setWaiting(waiting.isWaiting, waiting.humans, waiting.needed);
    if (lastBoard) setScoreboard(lastBoard, lastYou);
  }

  function setMode(m) { mode = m; if (earnMetric) earnMetric.hidden = false; } // both modes earn (wager = real, free = practice)
  function setBalance() { /* total balance is intentionally not shown in-game */ }

  function pulse(el) { if (!el) return; el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }

  function spawnFloat(text) {
    if (!floatsEl) return;
    const f = document.createElement('div');
    f.className = 'kill-float';
    f.textContent = text;
    f.style.setProperty('--dx', `${Math.round((Math.random() * 2 - 1) * 34)}px`);
    floatsEl.appendChild(f);
    setTimeout(() => f.remove(), 1100);
  }

  function onKill(rewardCents, killsTotal) {
    kills = killsTotal != null ? killsTotal : kills + 1;
    earnedCents += rewardCents || 0;
    if (killsEl) { killsEl.textContent = String(kills); pulse(killsEl); }
    if (earnedEl) { earnedEl.textContent = money0(earnedCents); pulse(earnedEl); }
    if (rewardCents > 0) spawnFloat(`+${money0(rewardCents)}`);
    if (liveEl) liveEl.textContent = rewardCents ? `+${money0(rewardCents)}` : 'Kill';
  }

  function update(game) {
    const youId = game.youId ?? 0;
    const me = game.players[youId];
    const frac = me && game.cellCount ? me.area / game.cellCount : 0;
    if (territoryEl) territoryEl.textContent = `${(frac * 100).toFixed(1)}%`;
  }

  function setScoreboard(rows, youId) {
    lastBoard = rows; lastYou = youId;
    if (!scoreboardEl) return;
    if (!rows || !rows.length) { scoreboardEl.innerHTML = ''; scoreboardEl.hidden = true; return; }
    const showEarn = true; // both wager (real ◇) and free (practice ◇) show earnings
    scoreboardEl.classList.toggle('with-earn', showEarn);
    scoreboardEl.hidden = false;
    scoreboardEl.innerHTML = `<div class="sb-title">${t('sb.title')}</div>` + rows.map((r, i) =>
      `<div class="sb-row${r.id === youId ? ' me' : ''}${r.bot ? ' bot' : ''}">`
      + `<span class="sb-rank">${i + 1}</span>`
      + `<span class="sb-name">${esc(r.name)}</span>`
      + `<span class="sb-kills">${r.kills}</span>`
      + (showEarn ? `<span class="sb-earn">${money0(r.earnedCents || 0)}</span>` : '')
      + '</div>').join('');
  }

  function setWaiting(isWaiting, humans, needed) {
    waiting = { isWaiting, humans, needed };
    if (!banner) return;
    if (isWaiting) {
      banner.hidden = false;
      banner.textContent = t('hud.waiting', { n: humans || 0, need: needed || 2 });
    } else {
      banner.hidden = true;
    }
  }

  function reset() {
    kills = 0;
    earnedCents = 0;
    if (killsEl) killsEl.textContent = '0';
    if (earnedEl) earnedEl.textContent = money0(0);
    if (liveEl) liveEl.textContent = '';
  }

  applyLang();
  onLangChange(applyLang);

  return { update, reset, setWaiting, setMode, setBalance, onKill, setScoreboard };
}
