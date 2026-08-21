import * as THREE from 'three';
import { buildMap } from '../shared/map.ts';
import { Controller } from './controller.ts';
import { Perception } from './perception.ts';
import { Post } from './post.ts';
import { Net } from './net.ts';
import { Audio } from './audio.ts';
import { PLAYER, MATCH, RELIC, TOUCH } from '../shared/config.ts';
import { dirFromAngles } from '../shared/math.ts';
import { pulseShape } from '../shared/upgrades.ts';
import type { S2C, SelfState, MatchState, Stance, C2S } from '../shared/proto.ts';
import type { WeaponId } from '../shared/config.ts';

// ── boot ──────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const DPR = Math.min(devicePixelRatio, 2);
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.06, 300);
const map = buildMap();

const t0 = performance.now();
const clock = () => (performance.now() - t0) / 1000;

const per = new Perception(map.world, clock);
per.setDpr(DPR);
const refreshProjection = () =>
  per.setProjection(innerHeight * DPR, (camera.fov * Math.PI) / 180);
refreshProjection();
scene.add(per.group);

const post = new Post(renderer, scene, camera);
const audio = new Audio();
const ctl = new Controller(map.spawns[0]!, map.world);
ctl.tuning.walk = PLAYER.walkSpeed;
ctl.tuning.sprint = PLAYER.sprintSpeed;
ctl.tuning.crouch = PLAYER.crouchSpeed;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
  refreshProjection();
});

// ── game state (CLIENT-SIDE, never contains enemy data) ───────────────
type Screen = 'menu' | 'lobby' | 'game' | 'over';
let screen: Screen = 'menu';
let solo = false;
let mySlot = 0;
let weapon: WeaponId = 'judge';
let self: SelfState | null = null;
let match: MatchState | null = null;
let draft: { id: string; name: string; text: string }[] | null = null;
let locked = false;
const net = new Net();

const showScreen = (s: Screen) => {
  screen = s;
  $('s-menu').classList.toggle('hidden', s !== 'menu');
  $('s-lobby').classList.toggle('hidden', s !== 'lobby');
  $('s-over').classList.toggle('hidden', s !== 'over');
  if (s !== 'game' && document.pointerLockElement) document.exitPointerLock();
};

// ── menu / lobby wiring ───────────────────────────────────────────────
$('b-create').onclick = () => { net.send({ t: 'create', name: 'PLAYER' }); };
$('b-join').onclick = () => {
  const code = ($('i-code') as HTMLInputElement).value.trim().toUpperCase();
  if (code.length !== 6) { $('menu-err').textContent = 'CODE IS SIX CHARACTERS'; return; }
  net.send({ t: 'join', code, name: 'PLAYER' });
};
$('i-code').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('b-join').click(); });
$('b-solo').onclick = () => { solo = true; startSolo(); };
document.querySelectorAll<HTMLElement>('.wcard').forEach((el) => {
  el.onclick = () => {
    document.querySelectorAll('.wcard').forEach((o) => o.classList.remove('sel'));
    el.classList.add('sel');
    weapon = (el.dataset.w as WeaponId) ?? 'judge';
  };
});
$('b-ready').onclick = () => { net.send({ t: 'ready', weapon }); ($('b-ready') as HTMLButtonElement).disabled = true; };
$('b-rematch').onclick = () => {
  if (solo) { startSolo(); return; }
  net.send({ t: 'rematch' });
  ($('b-ready') as HTMLButtonElement).disabled = false;
  showScreen('lobby');
};

net.onMsg = (m: S2C) => {
  switch (m.t) {
    case 'hello': mySlot = m.slot; break;
    case 'lobby': {
      $('l-code').textContent = m.code;
      $('l-players').innerHTML = m.players
        .map((p, i) => `<div>${i === m.you ? '<b>YOU</b>' : 'OPPONENT'} · ${p.weapon.toUpperCase()} · ` +
          `<span class="${p.ready ? 'rdy' : ''}">${p.ready ? 'READY' : 'CHOOSING'}</span></div>`)
        .join('') + (m.players.length < 2 ? '<div style="opacity:.5">WAITING FOR OPPONENT…</div>' : '');
      showScreen('lobby');
      break;
    }
    case 'start': {
      per.reset();
      ($('b-ready') as HTMLButtonElement).disabled = false;
      showScreen('game');
      audio.resume();
      renderer.domElement.requestPointerLock?.();
      break;
    }
    case 'snap': {
      self = m.self; match = m.match;
      per.predictGhosts = m.self.upgrades.includes('extrapolator');
      ctl.canSprint = !m.self.carrying;
      // The server owns position. Correct softly so ordinary play feels local, but never
      // let the client drift away from the authoritative simulation.
      const dx = m.self.x - ctl.pos.x, dz = m.self.z - ctl.pos.z;
      const err = Math.hypot(dx, dz);
      if (err > 2.2) ctl.teleport({ x: m.self.x, y: m.self.y, z: m.self.z });
      else if (err > 0.05) { ctl.pos.x += dx * 0.28; ctl.pos.z += dz * 0.28; ctl.pos.y = m.self.y; }
      break;
    }
    case 'evs': {
      const now = clock();
      for (const e of m.evs) { per.applyEvent(e, e.t, now); audio.forEvent(e, ctl.pos, ctl.yaw); }
      break;
    }
    // An empty card list is the server confirming the pick, so the HUD can never
    // disagree with the simulation about whether an offer is still open.
    case 'offer': draft = m.cards.length ? m.cards : null; renderDraft(); break;
    case 'over': {
      $('o-title').textContent = m.winner === m.you ? 'EXTRACTED' : 'LOST';
      $('o-reason').textContent = m.reason.toUpperCase();
      $('o-stats').innerHTML = self
        ? `LEVEL ${self.level} &nbsp;·&nbsp; ${self.xp} XP &nbsp;·&nbsp; ${self.upgrades.map((u) => u.toUpperCase()).join(' + ') || 'NO UPGRADES'}`
        : '';
      showScreen('over');
      break;
    }
    case 'err': $('menu-err').textContent = m.msg; $('lobby-err').textContent = m.msg; break;
  }
};
net.onClose = () => { if (!solo) $('menu-err').textContent = 'CONNECTION LOST'; };
net.connect();

// ── SOLO WALK: an offline sandbox for learning to read the space ──────
let soloPulseReadyAt = 0;
let soloStart = 0;
function startSolo() {
  solo = true;
  per.reset();
  ctl.teleport(map.spawns[0]!, map.spawns[0]!.yaw);
  self = {
    x: ctl.pos.x, y: 0, z: ctl.pos.z, hp: 100, alive: true, respawnIn: 0,
    weapon: 'judge', ammo: 5, reloading: 0, pulseCd: 0, spikes: 2, decoys: 2,
    echoes: 2, echoCd: 0, xp: 0, level: 1, carrying: false, channel: 0, upgrades: [],
  };
  match = { t: 0, phase: 'live', overdrive: false, relicHeld: 0, beaconLit: false, bx: 29, by: 0, bz: 26.5 };
  soloStart = clock();
  soloPulseReadyAt = 0;
  showScreen('game');
  audio.resume();
  renderer.domElement.requestPointerLock?.();
}

// ── input ─────────────────────────────────────────────────────────────
const SENS = 0.0021;
renderer.domElement.addEventListener('click', () => {
  if (screen === 'game' && !locked) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === renderer.domElement; });
document.addEventListener('mousemove', (e) => { if (locked) ctl.look(e.movementX, e.movementY, SENS); });

function aim() { return dirFromAngles(ctl.yaw, ctl.pitch); }

renderer.domElement.addEventListener('mousedown', (e) => {
  if (!locked || screen !== 'game') return;
  const d = aim();
  if (e.button === 0) fireWeapon(d);
  if (e.button === 2) doPulse(d);
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

function doPulse(d: { x: number; y: number; z: number }) {
  if (solo) {
    const now = clock();
    if (now < soloPulseReadyAt) return;
    const sh = pulseShape(new Set(self?.upgrades ?? []));
    soloPulseReadyAt = now + sh.cd;
    per.applyEvent({
      k: 'geom', t: now, src: 'pulse', ox: ctl.pos.x, oy: ctl.eyeY, oz: ctl.pos.z,
      dx: d.x, dy: d.y, dz: d.z, half: (sh.halfDeg * Math.PI) / 180, range: sh.range,
      rays: 46000, speed: 60, seed: (Math.random() * 1e9) >>> 0,
    }, now, now);
    audio.pulse();
    return;
  }
  net.send({ t: 'pulse', dx: d.x, dy: d.y, dz: d.z });
}
function fireWeapon(d: { x: number; y: number; z: number }) {
  if (solo) return;
  net.send({ t: 'fire', dx: d.x, dy: d.y, dz: d.z });
}

let firing = false;
renderer.domElement.addEventListener('mousedown', (e) => { if (e.button === 0) firing = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });

addEventListener('keydown', (e) => {
  if (screen !== 'game') return;
  ctl.keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); doPulse(aim()); }
  if (e.code === 'KeyR') net.send({ t: 'reload' });
  if (e.code === 'KeyQ') sendGadget('spike');
  if (e.code === 'KeyE') sendGadget('decoy');
  if (e.code === 'KeyF') sendGadget('echo');
  if (draft && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3')) {
    const i = Number(e.code.slice(5)) - 1;
    const c = draft[i];
    if (c) { net.send({ t: 'upgrade', id: c.id }); draft = null; renderDraft(); }
  }
});
addEventListener('keyup', (e) => ctl.keys.delete(e.code));
addEventListener('blur', () => { ctl.keys.clear(); firing = false; });

const sendGadget = (g: 'spike' | 'decoy' | 'echo') => {
  if (solo) return;
  const d = aim();
  net.send({ t: 'gadget', g, dx: d.x, dy: d.y, dz: d.z });
};

// ── HUD ───────────────────────────────────────────────────────────────
function renderDraft() {
  const el = $('draft');
  el.classList.toggle('hidden', !draft);
  if (!draft) return;
  $('dcards').innerHTML = draft
    .map((c, i) => `<div class="dcard"><b><u>${i + 1}</u> &nbsp;${c.name}</b><span>${c.text}</span></div>`)
    .join('');
}

let noticeSeen = 0;
function renderNotices() {
  const box = $('notices');
  for (; noticeSeen < per.notices.length; noticeSeen++) {
    const n = per.notices[noticeSeen]!;
    const d = document.createElement('div');
    d.className = `nt ${n.tone}`;
    d.textContent = n.text;
    box.appendChild(d);
    setTimeout(() => d.remove(), 3500);
  }
}

const cdArc = $('cdarc') as unknown as SVGCircleElement;
const CIRC = 106.8;
function renderHud(now: number) {
  if (!self || !match) return;
  const sh = pulseShape(new Set(self.upgrades));
  const cd = solo ? Math.max(0, soloPulseReadyAt - now) : self.pulseCd;
  const frac = 1 - Math.min(1, cd / sh.cd);
  cdArc.style.strokeDashoffset = String(CIRC * (1 - frac));
  cdArc.style.opacity = frac >= 1 ? '0.9' : '0.42';
  cdArc.style.stroke = frac >= 1 ? '#7fe4ff' : '#2E6FA8';

  const t = solo ? now - soloStart : match.t;
  const left = Math.max(0, MATCH.hardCapS - t);
  $('clock').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  $('clock').className = match.overdrive ? 'od' : '';

  $('hp').textContent = self.alive ? String(Math.round(self.hp)) : `RESPAWN ${self.respawnIn.toFixed(1)}`;
  $('hp').className = self.hp <= 35 ? 'low' : '';
  $('gad').innerHTML = `Q SPIKE <b>${self.spikes}</b> &nbsp; E DECOY <b>${self.decoys}</b> &nbsp; F ECHO <b>${self.echoes}</b>`;
  $('ammo').textContent = self.reloading > 0 ? `RELOAD ${self.reloading.toFixed(1)}` : String(self.ammo);
  $('wname').textContent = self.weapon.toUpperCase();
  $('carry').classList.toggle('hidden', !self.carrying);
  $('chan').classList.toggle('hidden', self.channel <= 0);
  ($('chan').firstElementChild as HTMLElement).style.width = `${self.channel * 100}%`;

  const lv = Math.min(3, self.level - 1);
  const lo = [0, 100, 250, 450][lv] ?? 0, hi = [100, 250, 450, 450][lv] ?? 450;
  $('xpbar').style.width = `${Math.min(100, ((self.xp - lo) / Math.max(1, hi - lo)) * 100)}%`;

  const hit = per.lastHit;
  $('dmg').style.opacity = hit && now - hit.at < 0.5 ? String(0.9 * (1 - (now - hit.at) / 0.5)) : '0';

  $('stats').innerHTML =
    `<span style="color:${fps < 40 ? '#FF5A2D' : '#2f4354'}">${fps.toFixed(0)} FPS</span> · ` +
    `${(per.structural.used / 1000).toFixed(0)}K PTS` + (solo ? ' · SOLO' : ` · ${net.ping.toFixed(0)}MS`);
  renderNotices();
}

// ── loop ──────────────────────────────────────────────────────────────
let last = clock();
let frames = 0, fpsAcc = 0, fps = 60;
let inputAcc = 0, seq = 0;
let fireAcc = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = clock();
  let dt = now - last; last = now;
  if (dt > 0.1) dt = 0.1;

  if (screen === 'game') {
    // Movement is gated on being in the match, not on pointer lock. Only mouse LOOK needs
    // the lock; requiring it for movement means a failed or refused lock leaves the player
    // unable to move at all, and it makes the movement path untestable.
    if (self?.alive ?? true) ctl.step(dt);
    per.selfPos.x = ctl.pos.x; per.selfPos.y = ctl.pos.y; per.selfPos.z = ctl.pos.z;
    per.touch(ctl.pos.x, ctl.eyeY, ctl.pos.z, now);
    if (match?.beaconLit) per.beacon(match.bx, match.by, match.bz, now);

    // 20Hz input upload.
    inputAcc += dt;
    if (!solo && inputAcc >= 0.05 && net.ready) {
      inputAcc = 0;
      const stance: Stance = ctl.crouching ? 0 : ctl.sprinting ? 2 : 1;
      net.send({ t: 'input', seq: seq++, x: ctl.pos.x, y: ctl.pos.y, z: ctl.pos.z,
        yaw: ctl.yaw, pitch: ctl.pitch, stance, vx: ctl.vel.x, vz: ctl.vel.z });
    }
    // Automatic fire for the Whisper while the button is held.
    if (firing && self && self.weapon === 'whisper') {
      fireAcc += dt;
      if (fireAcc > 0.12) { fireAcc = 0; fireWeapon(aim()); }
    }
    audio.step(ctl, dt, now);
  }

  per.step(now);

  camera.position.set(ctl.pos.x, ctl.eyeY, ctl.pos.z);
  camera.rotation.set(ctl.pitch, ctl.yaw, 0, 'YXZ');
  if (post.enabled) post.render(now); else renderer.render(scene, camera);

  frames++; fpsAcc += dt;
  if (fpsAcc > 0.5) { fps = frames / fpsAcc; frames = 0; fpsAcc = 0; post.autoQuality(fps); }
  renderHud(now);
}
frame();

// Automated-testing hook. Mirrors real input paths; grants no extra information.
(window as any).__bs = {
  ctl, per, clock, camera, map, post, net, audio,
  doPulse: () => doPulse(aim()),
  fire: () => fireWeapon(aim()),
  gadget: (g: 'spike' | 'decoy' | 'echo') => sendGadget(g),
  send: (m: C2S) => net.send(m),
  startSolo,
  screen: () => screen,
  state: () => ({ self, match, draft, mySlot }),
  setWeapon: (w: WeaponId) => { weapon = w; },
  ready: () => net.send({ t: 'ready', weapon }),
  clearField: () => per.reset(),
  pulseReset: () => { soloPulseReadyAt = 0; },
};
