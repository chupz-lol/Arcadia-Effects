import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_AFX = path.resolve(__dirname, '..');
const FLUTTER_VFX_DIR = path.resolve(ROOT_AFX, '..', '..', 'app', 'app_flutter', 'assets', 'images', 'vfx');

const browsers = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const exe = browsers.find(p => fs.existsSync(p));
if (!exe) {
  console.error('Ошибка: Не найден Chrome или Edge для сборки атласов.');
  process.exit(1);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log('--- Сборка эффектов для игры (Flame VFX) ---');
console.log('1. Запуск сервера Arcadia...');
const serverProc = spawn('node', ['server.mjs'], {
  cwd: ROOT_AFX,
  stdio: 'ignore'
});

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5179/api/list');
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error('Таймаут ожидания сервера');
}

const userDataDir = path.resolve(process.env.TEMP || '.', 'afx_export_' + Date.now());
const port = 9305;
let chromeProc = null;

try {
  await waitForServer();

  chromeProc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1600,1000',
    'http://localhost:5179/'
  ], { stdio: 'ignore' });

  async function getWsUrl() {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        const tabs = await res.json();
        const page = tabs.find(t => t.type === 'page' && t.url.includes('5179'));
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch {}
      await sleep(250);
    }
    throw new Error('Не удалось подключиться к браузеру по WebSocket');
  }

  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 1;
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const curId = id++;
      const handler = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === curId) {
          ws.removeEventListener('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  await sleep(1500);

  const jsCode = `
    (async () => {
      await import('/tools/devsnap.js');

      // 1. One-shot effects
      const oneShotEffects = [
        { file: 'RTS Hit Impact.json', slug: 'rts_hit_impact' },
        { file: 'RTS Unit Explosion.json', slug: 'rts_unit_explosion' },
        { file: 'RTS Muzzle Flash.json', slug: 'rts_muzzle_flash' }
      ];
      const results = [];
      for (const item of oneShotEffects) {
        await AFXDev.reload(item.file);
        const doc = AFX.state.doc;
        const built = AFX.Atlas.build(doc);
        await AFXDev.save(item.slug + '_rgba_atlas', built.canvas, true);
        results.push({ slug: item.slug, info: built.info, w: built.canvas.width, h: built.canvas.height });
      }

      // 2. Continuous looping effects with 100% seamless crossfade loop
      const loopEffects = [
        { file: 'RTS Damage Smoke.json', slug: 'rts_damage_smoke' },
        { file: 'RTS Damage Fire.json', slug: 'rts_damage_fire' }
      ];

      for (const item of loopEffects) {
        await AFXDev.reload(item.file);
        const doc = AFX.state.doc;
        const eng = new AFX.Engine();
        const frames = 32;
        const cols = 8;
        const rows = 4;
        const cellW = 256;
        const cellH = 256;
        const duration = 1.0;
        const dt = duration / frames;
        const tStart = 1.0;

        const frameC = document.createElement('canvas');
        frameC.width = doc.comp.w; frameC.height = doc.comp.h;
        const frameCtx = frameC.getContext('2d');

        const atlasC = document.createElement('canvas');
        atlasC.width = cols * cellW; atlasC.height = rows * cellH;
        const atlasCtx = atlasC.getContext('2d');

        const cG = document.createElement('canvas');
        cG.width = doc.comp.w; cG.height = doc.comp.h;
        const ctxG = cG.getContext('2d');

        const cH = document.createElement('canvas');
        cH.width = doc.comp.w; cH.height = doc.comp.h;
        const ctxH = cH.getContext('2d');

        for (let i = 0; i < frames; i++) {
          const w = i / frames;
          const tG = tStart + i * dt;
          const tH = tStart + duration + i * dt;

          ctxG.clearRect(0, 0, cG.width, cG.height);
          eng.render(doc, tG, ctxG);

          ctxH.clearRect(0, 0, cH.width, cH.height);
          eng.render(doc, tH, ctxH);

          frameCtx.clearRect(0, 0, frameC.width, frameC.height);
          frameCtx.globalAlpha = 1 - w;
          frameCtx.drawImage(cH, 0, 0);
          frameCtx.globalAlpha = w;
          frameCtx.drawImage(cG, 0, 0);
          frameCtx.globalAlpha = 1.0;

          const col = i % cols;
          const row = Math.floor(i / cols);
          atlasCtx.drawImage(frameC, 0, 0, frameC.width, frameC.height, col * cellW, row * cellH, cellW, cellH);
        }

        await AFXDev.save(item.slug + '_rgba_atlas', atlasC, true);
        results.push({ slug: item.slug, w: atlasC.width, h: atlasC.height, seamless: true });
      }

      return JSON.stringify(results);
    })()
  `;

  console.log('2. Генерация атласов высокого разрешения...');
  const evalRes = await send('Runtime.evaluate', {
    expression: jsCode,
    awaitPromise: true,
    returnByValue: true
  });
  ws.close();

} finally {
  if (chromeProc) {
    try { chromeProc.kill('SIGKILL'); } catch {}
  }
  if (serverProc) {
    try { serverProc.kill('SIGKILL'); } catch {}
  }
  try {
    const { execSync } = await import('child_process');
    execSync(`taskkill /F /PID ${chromeProc.pid} 2>nul || ver >nul`);
  } catch {}
  try {
    const { execSync } = await import('child_process');
    execSync(`taskkill /F /PID ${serverProc.pid} 2>nul || ver >nul`);
  } catch {}
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}

// Копирование готовых атласов в Flutter
console.log('3. Копирование файлов в клиент игры (app_flutter)...');
const snapDir = path.join(ROOT_AFX, '.snap');
const copies = [
  { src: 'rts_unit_explosion_rgba_atlas.png', dst: 'unit_explosion.png' },
  { src: 'rts_muzzle_flash_rgba_atlas.png', dst: 'muzzle_flash.png' },
  { src: 'rts_hit_impact_rgba_atlas.png', dst: 'hit_explosion.png' },
  { src: 'rts_damage_smoke_rgba_atlas.png', dst: 'damage_smoke.png' },
  { src: 'rts_damage_fire_rgba_atlas.png', dst: 'damage_fire.png' },
];

for (const c of copies) {
  const srcPath = path.join(snapDir, c.src);
  const dstPath = path.join(FLUTTER_VFX_DIR, c.dst);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, dstPath);
    const size = fs.statSync(dstPath).size;
    console.log(`   [OK] ${c.dst} (${(size / 1024).toFixed(1)} KB) -> assets/images/vfx/${c.dst}`);
  } else {
    console.error(`   [ОШИБКА] Файл не найден: ${srcPath}`);
  }
}

console.log('--- Готово! Все эффекты успешно экспортированы в игру! ---');
