import { chromium, Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

const URL_A      = process.env.URL_A      || 'https://app.nectarcrm.com.br/crm/crm/inicio#/';
const URL_B      = process.env.URL_B      || 'https://qa.nectarcrm.com.br/crm/crm/inicio#/';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './reports/session';

interface StepRecord {
  stepNum:      number;
  stitchedPath: string;
  urlBase:      string;
  urlConverted: string;
  timestamp:    number;
}

/* Script injetado em AMBAS as paginas:
   detecta clique simultaneo dos dois botoes do mouse (esquerdo+direito)
   e chama __takeScreenshot() exposta pelo Node */
const TRIGGER_SCRIPT = `
(function() {
  if (window.__triggerInjected) return;
  window.__triggerInjected = true;

  const pressed = new Set();
  let cooldown = false;

  document.addEventListener('mousedown', function(e) {
    pressed.add(e.button);
    // button 0 = esquerdo, button 2 = direito
    if (pressed.has(0) && pressed.has(2) && !cooldown) {
      cooldown = true;
      e.preventDefault();
      e.stopPropagation();
      window.__takeScreenshot();
      setTimeout(function() { cooldown = false; }, 1000);
    }
  }, true);

  document.addEventListener('mouseup', function(e) {
    pressed.delete(e.button);
  }, true);

  // Previne menu de contexto quando o trigger e acionado
  document.addEventListener('contextmenu', function(e) {
    if (pressed.has(0) || cooldown) e.preventDefault();
  }, true);

  console.log('[MirrorTest] Trigger ativo - clique ambos botoes do mouse para capturar');
})();
`;

function ensureDir(dir: string) { fs.mkdirSync(dir, { recursive: true }); }

function escHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function stitchScreenshots(
  page1: Page, page2: Page, stepNum: number, screensDir: string
): Promise<string> {
  const [ss1Buf, ss2Buf] = await Promise.all([
    page1.screenshot({ fullPage: false }),
    page2.screenshot({ fullPage: false }),
  ]);

  const padded = String(stepNum).padStart(4, '0');

  const img1Meta = await sharp(ss1Buf).metadata();
  const img2Meta = await sharp(ss2Buf).metadata();
  const w1 = img1Meta.width  || 1280;
  const h1 = img1Meta.height || 800;
  const w2 = img2Meta.width  || 1280;
  const h2 = img2Meta.height || 800;
  const totalH = Math.max(h1, h2);
  const labelH = 32;

  const labelBase = Buffer.from(
    `<svg width="${w1}" height="${labelH}">` +
    `<rect width="${w1}" height="${labelH}" fill="#1e3a5f"/>` +
    `<text x="${w1 / 2}" y="21" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="white">BASE</text>` +
    `</svg>`
  );

  const labelConverted = Buffer.from(
    `<svg width="${w2}" height="${labelH}">` +
    `<rect width="${w2}" height="${labelH}" fill="#4f46e5"/>` +
    `<text x="${w2 / 2}" y="21" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="white">CONVERTIDA</text>` +
    `</svg>`
  );

  const side1 = await sharp({
    create: { width: w1, height: totalH + labelH, channels: 3, background: '#f1f5f9' }
  })
    .composite([
      { input: await sharp(Buffer.from(labelBase)).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp(ss1Buf).png().toBuffer(), top: labelH, left: 0 },
    ])
    .png().toBuffer();

  const side2 = await sharp({
    create: { width: w2, height: totalH + labelH, channels: 3, background: '#f1f5f9' }
  })
    .composite([
      { input: await sharp(Buffer.from(labelConverted)).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp(ss2Buf).png().toBuffer(), top: labelH, left: 0 },
    ])
    .png().toBuffer();

  const separator = await sharp({
    create: { width: 4, height: totalH + labelH, channels: 3, background: '#cbd5e1' }
  }).png().toBuffer();

  const stitched = await sharp({
    create: { width: w1 + 4 + w2, height: totalH + labelH, channels: 3, background: '#f1f5f9' }
  })
    .composite([
      { input: side1, top: 0, left: 0 },
      { input: separator, top: 0, left: w1 },
      { input: side2, top: 0, left: w1 + 4 },
    ])
    .png().toBuffer();

  const outPath = path.join(screensDir, `step-${padded}.png`);
  fs.writeFileSync(outPath, stitched);
  return outPath;
}

function generateHtmlReport(steps: StepRecord[], dir: string) {
  const total = steps.length;

  const cards = steps.map(s => {
    const pad = String(s.stepNum).padStart(4, '0');
    return `
    <div class="card" id="step-${s.stepNum}">
      <div class="card-header">
        <span class="step-num">Captura ${s.stepNum}</span>
        <span class="step-label">${escHtml(new Date(s.timestamp).toLocaleTimeString('pt-BR'))}</span>
      </div>
      <div class="screenshots">
        <img src="screenshots/step-${pad}.png" loading="lazy" style="width:100%;border-radius:8px;border:1px solid #e2e8f0;cursor:zoom-in"/>
      </div>
    </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<title>MirrorTest Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;line-height:1.5}
header{background:#1e3a5f;color:#fff;padding:20px 32px;display:flex;align-items:center;gap:16px}
header h1{font-size:20px;font-weight:600}
.sub{font-size:12px;opacity:.7;margin-top:2px}
.stats{display:flex;gap:10px;margin-left:auto}
.stat{background:rgba(255,255,255,.15);border-radius:8px;padding:8px 14px;text-align:center}
.stat-num{font-size:20px;font-weight:700}
.stat-lbl{font-size:11px;opacity:.8}
.main{max-width:1440px;margin:0 auto;padding:24px}
.card{background:#fff;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden}
.card-header{padding:14px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #f1f5f9;flex-wrap:wrap}
.step-num{background:#1e3a5f;color:#fff;font-size:12px;font-weight:600;padding:2px 10px;border-radius:20px}
.step-label{font-size:14px;font-weight:500;flex:1;color:#64748b}
.screenshots{padding:16px}
.card.hide{display:none}
.lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out}
.lb.open{display:flex}
.lb img{max-width:92vw;max-height:90vh;border-radius:8px}
</style>
</head>
<body>
<header>
  <div>
    <h1>MirrorTest Report</h1>
    <div class="sub">Base: ${escHtml(URL_A)} | Convertida: ${escHtml(URL_B)}</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-lbl">Capturas</div></div>
  </div>
</header>
<div class="main">
  <div id="cards">${cards}</div>
</div>
<div class="lb" id="lb" onclick="this.classList.remove('open')">
  <img id="lb-img" src=""/>
</div>
<script>
document.addEventListener('click',e=>{
  if(e.target.tagName==='IMG'&&e.target.closest('.screenshots')){
    document.getElementById('lb-img').src=e.target.src;
    document.getElementById('lb').classList.add('open');
  }
});
</script>
</body>
</html>`;

  fs.writeFileSync(path.join(dir, 'report.html'), html, 'utf8');
}

async function run() {
  const sessionDir = OUTPUT_DIR;
  const screensDir = path.join(sessionDir, 'screenshots');
  ensureDir(screensDir);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║        MirrorTest - Playwright           ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Base      : ${URL_A.slice(0, 27).padEnd(27)}║`);
  console.log(`║  Convertida: ${URL_B.slice(0, 27).padEnd(27)}║`);
  console.log(`║  Output    : ${sessionDir.padEnd(27)}║`);
  console.log('╚══════════════════════════════════════════╝\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  // viewport: null faz o conteudo acompanhar o tamanho da janela
  const ctxA: BrowserContext = await browser.newContext({ viewport: null });
  const ctxB: BrowserContext = await browser.newContext({ viewport: null });
  const page1 = await ctxA.newPage();
  const page2 = await ctxB.newPage();

  console.log('Abrindo Aba 1 (Base)...');
  await page1.goto(URL_A, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Abrindo Aba 2 (Convertida)...');
  await page2.goto(URL_B, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const steps: StepRecord[] = [];
  let stepNum = 0;
  let capturing = false;

  async function captureScreenshot() {
    if (capturing) return;
    capturing = true;
    stepNum++;
    const current = stepNum;

    console.log(`\n[Captura ${current}] Tirando screenshot...`);

    try {
      const outPath = await stitchScreenshots(page1, page2, current, screensDir);
      console.log(`           Salvo: ${outPath}`);

      steps.push({
        stepNum: current,
        stitchedPath: outPath,
        urlBase: page1.url(),
        urlConverted: page2.url(),
        timestamp: Date.now(),
      });

      fs.writeFileSync(
        path.join(sessionDir, 'steps.json'),
        JSON.stringify(steps, null, 2)
      );
      generateHtmlReport(steps, sessionDir);
    } catch (err: any) {
      console.warn(`           Falhou: ${err?.message || err}`);
    }

    capturing = false;
  }

  // Expoe a funcao de screenshot em ambas as paginas
  await page1.exposeFunction('__takeScreenshot', captureScreenshot);
  await page2.exposeFunction('__takeScreenshot', captureScreenshot);

  // Injeta o trigger em ambas as paginas
  async function injectTrigger(page: Page) {
    try { await page.evaluate(TRIGGER_SCRIPT); } catch {}
  }

  await injectTrigger(page1);
  await injectTrigger(page2);

  // Re-injeta apos navegacoes
  page1.on('load', () => injectTrigger(page1));
  page2.on('load', () => injectTrigger(page2));
  page1.on('framenavigated', (frame) => { if (frame === page1.mainFrame()) injectTrigger(page1); });
  page2.on('framenavigated', (frame) => { if (frame === page2.mainFrame()) injectTrigger(page2); });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PRONTO! Navegue livremente nas duas abas.');
  console.log('  Clique AMBOS os botoes do mouse ao mesmo');
  console.log('  tempo (esquerdo+direito) para capturar.');
  console.log('  Pressione Ctrl+C para finalizar.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.on('SIGINT', async () => {
    console.log(`\nFinalizando... ${steps.length} capturas.`);
    if (steps.length > 0) {
      generateHtmlReport(steps, sessionDir);
      console.log(`Report: ${path.resolve(path.join(sessionDir, 'report.html'))}`);
    }
    await browser.close();
    process.exit(0);
  });

  await new Promise(() => {});
}

run().catch(err => { console.error('Erro fatal:', err); process.exit(1); });
