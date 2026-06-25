import './styles.css';
import * as pc from 'playcanvas';
import { ArenaRenderer } from './adapters/arenaRenderer.mjs';
import { InputController } from './adapters/inputController.mjs';
import { createHud } from './ui/hud.mjs';
import { createScreens } from './ui/screens.mjs';
import { NetClient } from './net/netClient.mjs';
import { getToken } from './net/api.mjs';
import { t } from './i18n.mjs';

const canvas = document.querySelector('#application');

const app = new pc.Application(canvas, {
  graphicsDeviceOptions: { antialias: true, alpha: false, powerPreference: 'high-performance' },
});
app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
app.start();
window.addEventListener('resize', () => app.resizeCanvas(canvas.clientWidth, canvas.clientHeight));

let net = null;
let renderer = null;
let firstFramePending = false;
let connectSeq = 0;
const input = new InputController({ canvas });

const hud = createHud({
  onMenu: () => leaveToMenu(),
});

const screens = createScreens({
  onPlay: (mode) => startGame(mode),
  onRespawn: () => net && net.sendRespawn(),
  onLeave: () => leaveToMenu(),
});

function startGame(mode) {
  const user = screens.getUser();
  screens.enterGame();
  hud.showLoading();          // loader covers the arena until the first frame renders
  hud.setMode(mode);
  hud.reset();
  firstFramePending = true;
  const myConnect = ++connectSeq;
  // safety: if the arena never renders a first frame (server unreachable), bail to menu
  setTimeout(() => {
    if (firstFramePending && connectSeq === myConnect) { leaveToMenu(); screens.toast(t('toast.connectFailed')); }
  }, 15000);
  net = new NetClient(user ? user.username : 'Guest', { token: getToken(), mode });
  wireNet(net);
  net.connect();
}

function leaveToMenu() {
  if (net) { net.disconnect(); net = null; }
  firstFramePending = false;
  hud.hideLoading();
  hud.setIdle(0);
  hud.setScoreboard([]);
  screens.showMenu();
}

function wireNet(n) {
  n.on('keyframe', () => {
    if (!renderer) renderer = new ArenaRenderer(app, n.mirror);
    else renderer.reset(n.mirror);
    renderer.setFollow(n.mirror.youId);
    hud.reset();
  });
  n.on('status', (status, humans, needed) => hud.setWaiting(status === 'waiting', humans, needed));
  n.on('respawn', () => { hud.setIdle(0); hud.reset(); screens.enterGame(); });
  n.on('wallet', (w) => screens.setWallet(w));
  n.on('kill', (k) => {
    hud.onKill(k.rewardCents, k.kills);
    if (k.wallet) screens.setWallet(k.wallet);
  });
  n.on('idle', (secs) => hud.setIdle(secs));
  n.on('death', (d) => { hud.setIdle(0); screens.setWallet(d.wallet); screens.showDeath(d); });
  n.on('victory', (d) => { hud.setIdle(0); screens.setWallet(d.wallet); screens.showDeath({ ...d, won: true }); });
  // someone conquered the arena → match over for all; the winner/conquered already have a
  // result screen, so only nudge spectators/waiting players with a toast.
  n.on('matchover', (m) => { hud.setIdle(0); if (!screens.isOpen()) screens.toast(t('toast.matchOver', { name: m.winner })); });
  n.on('scoreboard', (rows) => hud.setScoreboard(rows, n.mirror.youId));
  n.on('error', (code) => {
    if (code === 'insufficient_funds') { leaveToMenu(); screens.toast(t('toast.notEnough')); }
    else if (code === 'full') { leaveToMenu(); screens.toast(t('toast.full')); }
    else if (code === 'already_in_game') { leaveToMenu(); screens.toast(t('toast.alreadyInGame')); }
    else if (code === 'practice_empty') { leaveToMenu(); screens.toast(t('toast.practiceEmpty')); }
  });
}

app.on('update', () => {
  if (!net) return;
  const M = net.mirror;
  if (M.players.length && !screens.isOpen()) {
    const cmd = input.getCommand(net.getIntentDir());
    if (cmd) net.sendInput(cmd);
  }
  if (renderer) {
    renderer.render(net.getAlpha());
    if (firstFramePending) { firstFramePending = false; hud.hideLoading(); } // arena drawn → reveal HUD
    hud.update(M);
  }
});

screens.bootstrap();
