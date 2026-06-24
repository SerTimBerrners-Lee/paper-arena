import './styles.css';
import * as pc from 'playcanvas';
import { ArenaRenderer } from './adapters/arenaRenderer.mjs';
import { InputController } from './adapters/inputController.mjs';
import { createHud } from './ui/hud.mjs';
import { createScreens } from './ui/screens.mjs';
import { NetClient } from './net/netClient.mjs';
import { getToken, fmtMoney } from './net/api.mjs';
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
  hud.setMode(mode);
  hud.reset();
  net = new NetClient(user ? user.username : 'Guest', { token: getToken(), mode });
  wireNet(net);
  net.connect();
}

function leaveToMenu() {
  if (net) { net.disconnect(); net = null; }
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
  n.on('respawn', () => { hud.reset(); screens.enterGame(); });
  n.on('wallet', (w) => screens.setWallet(w));
  n.on('kill', (k) => {
    hud.onKill(k.rewardCents, k.kills);
    if (k.wallet) screens.setWallet(k.wallet);
  });
  n.on('death', (d) => { screens.setWallet(d.wallet); screens.showDeath(d); });
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
    hud.update(M);
  }
});

screens.bootstrap();
