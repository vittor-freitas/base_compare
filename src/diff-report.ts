import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const INPUT_DIR  = process.env.INPUT_DIR  || './reports/session/screenshots';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './reports/diff';
const THRESHOLD  = Number(process.env.DIFF_THRESHOLD || '0.1'); // sensibilidade pixelmatch (0=exato, 1=permissivo)

interface DiffResult {
  file:         string;
  diffPixels:   number;
  totalPixels:  number;
  diffPercent:  number;
  diffImage:    string; // path relativo da imagem diff
  baseImage:    string;
  convertImage: string;
  regions:      DiffRegion[];
}

interface DiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

const LABEL_H    = 32; // altura do label BASE/CONVERTIDA
const SEPARATOR  = 4;  // largura do separador central

function ensureDir(dir: string) { fs.mkdirSync(dir, { recursive: true }); }

/**
 * Dado um screenshot stitched (BASE | sep | CONVERTIDA),
 * extrai as duas metades sem o label e sem o separador.
 */
async function splitStitched(filePath: string): Promise<{ left: Buffer; right: Buffer; w: number; h: number }> {
  const meta = await sharp(filePath).metadata();
  const fullW = meta.width!;
  const fullH = meta.height!;

  // Cada lado tem (fullW - SEPARATOR) / 2 de largura
  const sideW = Math.floor((fullW - SEPARATOR) / 2);
  const contentH = fullH - LABEL_H;

  const left = await sharp(filePath)
    .extract({ left: 0, top: LABEL_H, width: sideW, height: contentH })
    .png()
    .toBuffer();

  const right = await sharp(filePath)
    .extract({ left: sideW + SEPARATOR, top: LABEL_H, width: sideW, height: contentH })
    .png()
    .toBuffer();

  return { left, right, w: sideW, h: contentH };
}

/**
 * Compara dois buffers PNG pixel a pixel.
 * Retorna o numero de pixels diferentes e o buffer da imagem diff.
 */
function compareImages(
  leftBuf: Buffer, rightBuf: Buffer, w: number, h: number
): { diffPixels: number; diffPng: Buffer } {
  const img1 = PNG.sync.read(leftBuf);
  const img2 = PNG.sync.read(rightBuf);

  // Garante dimensoes iguais (usa o minimo)
  const cw = Math.min(img1.width, img2.width);
  const ch = Math.min(img1.height, img2.height);

  const diff = new PNG({ width: cw, height: ch });

  const diffPixels = pixelmatch(
    img1.data, img2.data, diff.data,
    cw, ch,
    { threshold: THRESHOLD, includeAA: false, alpha: 0.3 }
  );

  return { diffPixels, diffPng: PNG.sync.write(diff) };
}

/**
 * Detecta regioes retangulares com concentracao de pixels diferentes.
 * Divide a imagem em blocos e agrupa blocos adjacentes com diferencas.
 */
function detectRegions(diffPng: Buffer, w: number, h: number): DiffRegion[] {
  const img = PNG.sync.read(diffPng);
  const blockSize = 32;
  const cols = Math.ceil(w / blockSize);
  const rows = Math.ceil(h / blockSize);

  // Mapa de blocos com diferencas
  const grid: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let count = 0;
      const startX = bx * blockSize;
      const startY = by * blockSize;
      const endX = Math.min(startX + blockSize, img.width);
      const endY = Math.min(startY + blockSize, img.height);

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const idx = (y * img.width + x) * 4;
          // pixelmatch pinta pixels diferentes em vermelho (R > 0)
          if (img.data[idx] > 100 || img.data[idx + 1] > 0) count++;
        }
      }

      // Se mais de 5% do bloco tem diferencas, marca
      const total = (endX - startX) * (endY - startY);
      if (count > total * 0.05) grid[by][bx] = true;
    }
  }

  // Agrupa blocos adjacentes em regioes (flood fill simples)
  const visited: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const regions: DiffRegion[] = [];

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      if (!grid[by][bx] || visited[by][bx]) continue;

      let minX = bx, maxX = bx, minY = by, maxY = by;
      const queue: [number, number][] = [[bx, by]];
      visited[by][bx] = true;

      while (queue.length > 0) {
        const [cx, cy] = queue.shift()!;
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !visited[ny][nx] && grid[ny][nx]) {
            visited[ny][nx] = true;
            queue.push([nx, ny]);
            minX = Math.min(minX, nx);
            maxX = Math.max(maxX, nx);
            minY = Math.min(minY, ny);
            maxY = Math.max(maxY, ny);
          }
        }
      }

      const rx = minX * blockSize;
      const ry = minY * blockSize;
      const rw = (maxX - minX + 1) * blockSize;
      const rh = (maxY - minY + 1) * blockSize;

      // Descreve a posicao da regiao
      const posY = ry < h * 0.33 ? 'topo' : ry < h * 0.66 ? 'meio' : 'rodape';
      const posX = rx < w * 0.33 ? 'esquerda' : rx < w * 0.66 ? 'centro' : 'direita';

      regions.push({ x: rx, y: ry, w: rw, h: rh, label: `${posY}-${posX}` });
    }
  }

  // Ordena por tamanho (maiores primeiro)
  regions.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  return regions;
}

/**
 * Gera imagem lado-a-lado com overlay de diff
 */
async function generateDiffOverlay(
  leftBuf: Buffer, rightBuf: Buffer, diffPng: Buffer,
  w: number, h: number, regions: DiffRegion[]
): Promise<Buffer> {
  const labelH = 28;

  // Overlay semi-transparente do diff sobre a imagem direita
  const diffOverlay = await sharp(diffPng)
    .composite([{
      input: rightBuf,
      blend: 'dest-over',
    }])
    .png().toBuffer();

  // Labels
  const labelBase = Buffer.from(
    `<svg width="${w}" height="${labelH}">` +
    `<rect width="${w}" height="${labelH}" fill="#1e3a5f"/>` +
    `<text x="${w / 2}" y="18" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="white">BASE</text>` +
    `</svg>`
  );
  const labelDiff = Buffer.from(
    `<svg width="${w}" height="${labelH}">` +
    `<rect width="${w}" height="${labelH}" fill="#dc2626"/>` +
    `<text x="${w / 2}" y="18" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="white">DIFERENCAS</text>` +
    `</svg>`
  );
  const labelConv = Buffer.from(
    `<svg width="${w}" height="${labelH}">` +
    `<rect width="${w}" height="${labelH}" fill="#4f46e5"/>` +
    `<text x="${w / 2}" y="18" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="white">CONVERTIDA</text>` +
    `</svg>`
  );

  // Retangulos de destaque sobre o diff
  const rects = regions.slice(0, 10).map(r =>
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#ff0" stroke-width="2" stroke-dasharray="6,3"/>`
  ).join('');
  const highlightSvg = Buffer.from(
    `<svg width="${w}" height="${h}">${rects}</svg>`
  );

  const sep = 3;
  const totalW = w * 3 + sep * 2;
  const totalH = h + labelH;

  const side1 = await sharp({ create: { width: w, height: totalH, channels: 4, background: '#f1f5f9' } })
    .composite([
      { input: await sharp(Buffer.from(labelBase)).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp(leftBuf).png().toBuffer(), top: labelH, left: 0 },
    ]).png().toBuffer();

  const side2 = await sharp({ create: { width: w, height: totalH, channels: 4, background: '#f1f5f9' } })
    .composite([
      { input: await sharp(Buffer.from(labelDiff)).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp(diffOverlay).png().toBuffer(), top: labelH, left: 0 },
      { input: await sharp(highlightSvg).png().toBuffer(), top: labelH, left: 0 },
    ]).png().toBuffer();

  const side3 = await sharp({ create: { width: w, height: totalH, channels: 4, background: '#f1f5f9' } })
    .composite([
      { input: await sharp(Buffer.from(labelConv)).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp(rightBuf).png().toBuffer(), top: labelH, left: 0 },
    ]).png().toBuffer();

  const sepBuf = await sharp({ create: { width: sep, height: totalH, channels: 3, background: '#cbd5e1' } })
    .png().toBuffer();

  return sharp({ create: { width: totalW, height: totalH, channels: 4, background: '#f1f5f9' } })
    .composite([
      { input: side1, top: 0, left: 0 },
      { input: sepBuf, top: 0, left: w },
      { input: side2, top: 0, left: w + sep },
      { input: sepBuf, top: 0, left: w * 2 + sep },
      { input: side3, top: 0, left: w * 2 + sep * 2 },
    ])
    .png().toBuffer();
}

function escHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateHtmlReport(results: DiffResult[], dir: string) {
  const total = results.length;
  const withDiff = results.filter(r => r.diffPercent > 0.5).length;
  const identical = total - withDiff;

  const cards = results.map((r, i) => {
    const pct = r.diffPercent.toFixed(2);
    const barColor = r.diffPercent < 1 ? '#22c55e' : r.diffPercent < 5 ? '#f59e0b' : '#ef4444';
    const statusLabel = r.diffPercent < 0.5 ? 'Identico' : r.diffPercent < 5 ? 'Pequenas diferencas' : 'Diferencas significativas';

    const regionList = r.regions.length > 0
      ? `<div class="regions"><strong>Regioes com diferenca:</strong><ul>${r.regions.slice(0, 8).map(reg =>
          `<li>Area ${reg.label} (${reg.w}x${reg.h}px em x:${reg.x} y:${reg.y})</li>`
        ).join('')}</ul></div>`
      : '';

    return `
    <div class="card ${r.diffPercent < 0.5 ? 'identical' : ''}" id="step-${i}">
      <div class="card-header">
        <span class="step-num">${escHtml(path.basename(r.file, '.png'))}</span>
        <span class="step-label">${statusLabel}</span>
        <span class="diff-pct" style="color:${barColor}">${pct}% diferente</span>
      </div>
      <div class="diff-bar"><div class="diff-fill" style="width:${Math.min(r.diffPercent, 100)}%;background:${barColor}"></div></div>
      ${regionList}
      <div class="screenshots">
        <img src="diffs/${escHtml(path.basename(r.diffImage))}" loading="lazy"/>
      </div>
    </div>`;
  }).join('\n');

  const avgDiff = total > 0 ? (results.reduce((s, r) => s + r.diffPercent, 0) / total).toFixed(2) : '0';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<title>Diff Report - Base vs Convertida</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;line-height:1.5}
header{background:#7c2d12;color:#fff;padding:20px 32px;display:flex;align-items:center;gap:16px}
header h1{font-size:20px;font-weight:600}
.sub{font-size:12px;opacity:.7;margin-top:2px}
.stats{display:flex;gap:10px;margin-left:auto}
.stat{background:rgba(255,255,255,.15);border-radius:8px;padding:8px 14px;text-align:center}
.stat-num{font-size:20px;font-weight:700}
.stat-lbl{font-size:11px;opacity:.8}
.main{max-width:1600px;margin:0 auto;padding:24px}
.toolbar{display:flex;gap:8px;margin-bottom:16px;align-items:center}
.btn{padding:5px 14px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;font-size:13px;cursor:pointer;color:#374151}
.btn.active{background:#7c2d12;color:#fff;border-color:#7c2d12}
.card{background:#fff;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden}
.card-header{padding:14px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #f1f5f9;flex-wrap:wrap}
.step-num{background:#7c2d12;color:#fff;font-size:12px;font-weight:600;padding:2px 10px;border-radius:20px}
.step-label{font-size:14px;font-weight:500;flex:1}
.diff-pct{font-size:13px;font-weight:600}
.diff-bar{height:4px;background:#e2e8f0;border-radius:2px;margin:0 20px}
.diff-fill{height:100%;border-radius:2px}
.regions{padding:10px 20px;font-size:12px;color:#64748b}
.regions ul{margin:4px 0 0 20px}
.regions li{margin:2px 0}
.screenshots{padding:16px}
.screenshots img{width:100%;border-radius:8px;border:1px solid #e2e8f0;cursor:zoom-in}
.card.hide{display:none}
.lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out}
.lb.open{display:flex}
.lb img{max-width:95vw;max-height:95vh;border-radius:4px}
.summary{background:#fff;border-radius:12px;border:1px solid #e2e8f0;padding:20px;margin-bottom:20px}
.summary h2{font-size:16px;margin-bottom:10px}
.summary p{font-size:13px;color:#64748b;margin:4px 0}
</style>
</head>
<body>
<header>
  <div>
    <h1>Diff Report - Base vs Convertida</h1>
    <div class="sub">Analise pixel-a-pixel das capturas</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-lbl">Total</div></div>
    <div class="stat"><div class="stat-num" style="color:#4ade80">${identical}</div><div class="stat-lbl">Identicos</div></div>
    <div class="stat"><div class="stat-num" style="color:#f87171">${withDiff}</div><div class="stat-lbl">Diferentes</div></div>
    <div class="stat"><div class="stat-num">${avgDiff}%</div><div class="stat-lbl">Media diff</div></div>
  </div>
</header>
<div class="main">
  <div class="toolbar">
    <button class="btn active" onclick="filter(this,'all')">Todos (${total})</button>
    <button class="btn" onclick="filter(this,'diff')">Com diferenca (${withDiff})</button>
    <button class="btn" onclick="filter(this,'same')">Identicos (${identical})</button>
  </div>
  <div id="cards">${cards}</div>
</div>
<div class="lb" id="lb" onclick="this.classList.remove('open')">
  <img id="lb-img" src=""/>
</div>
<script>
function filter(btn,f){
  document.querySelectorAll('.btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.card').forEach(card=>{
    if(f==='all'){card.classList.remove('hide');return;}
    const identical=card.classList.contains('identical');
    card.classList.toggle('hide',f==='diff'?identical:!identical);
  });
}
document.addEventListener('click',e=>{
  if(e.target.tagName==='IMG'&&e.target.closest('.screenshots')){
    document.getElementById('lb-img').src=e.target.src;
    document.getElementById('lb').classList.add('open');
  }
});
</script>
</body>
</html>`;

  fs.writeFileSync(path.join(dir, 'diff-report.html'), html, 'utf8');
}

async function run() {
  const inputDir = path.resolve(INPUT_DIR);
  const outputDir = path.resolve(OUTPUT_DIR);
  const diffsDir = path.join(outputDir, 'diffs');
  ensureDir(diffsDir);

  const files = fs.readdirSync(inputDir)
    .filter(f => f.startsWith('step-') && f.endsWith('.png'))
    .sort();

  if (files.length === 0) {
    console.log('Nenhum screenshot encontrado em', inputDir);
    process.exit(1);
  }

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║       Diff Report - Analise Visual       ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Screenshots: ${String(files.length).padEnd(26)}║`);
  console.log(`║  Input      : ${inputDir.slice(-26).padEnd(26)}║`);
  console.log(`║  Output     : ${outputDir.slice(-26).padEnd(26)}║`);
  console.log(`║  Threshold  : ${String(THRESHOLD).padEnd(26)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  const results: DiffResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(inputDir, file);
    const name = path.basename(file, '.png');

    process.stdout.write(`[${i + 1}/${files.length}] ${name}...`);

    try {
      const { left, right, w, h } = await splitStitched(filePath);
      const { diffPixels, diffPng } = compareImages(left, right, w, h);
      const totalPixels = w * h;
      const diffPercent = (diffPixels / totalPixels) * 100;

      const regions = detectRegions(diffPng, w, h);

      // Gera imagem diff (BASE | DIFF | CONVERTIDA)
      const overlay = await generateDiffOverlay(left, right, diffPng, w, h, regions);
      const diffImagePath = path.join(diffsDir, `${name}-diff.png`);
      fs.writeFileSync(diffImagePath, overlay);

      results.push({
        file,
        diffPixels,
        totalPixels,
        diffPercent,
        diffImage: `${name}-diff.png`,
        baseImage: file,
        convertImage: file,
        regions,
      });

      const bar = diffPercent < 0.5 ? '✓ identico' : diffPercent < 5 ? `△ ${diffPercent.toFixed(2)}%` : `✗ ${diffPercent.toFixed(2)}%`;
      console.log(` ${bar} (${regions.length} regioes)`);
    } catch (err: any) {
      console.log(` ERRO: ${err.message}`);
    }
  }

  // Resumo
  const withDiff = results.filter(r => r.diffPercent > 0.5);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  RESUMO`);
  console.log(`  Total:      ${results.length} screenshots analisados`);
  console.log(`  Identicos:  ${results.length - withDiff.length}`);
  console.log(`  Diferentes: ${withDiff.length}`);
  if (results.length > 0) {
    const avg = results.reduce((s, r) => s + r.diffPercent, 0) / results.length;
    const max = Math.max(...results.map(r => r.diffPercent));
    console.log(`  Media diff: ${avg.toFixed(2)}%`);
    console.log(`  Max diff:   ${max.toFixed(2)}%`);
  }

  if (withDiff.length > 0) {
    console.log(`\n  Top diferencas:`);
    withDiff
      .sort((a, b) => b.diffPercent - a.diffPercent)
      .slice(0, 10)
      .forEach((r, i) => {
        console.log(`    ${i + 1}. ${r.file} - ${r.diffPercent.toFixed(2)}% (${r.regions.length} regioes)`);
        r.regions.slice(0, 3).forEach(reg => {
          console.log(`       → ${reg.label} (${reg.w}x${reg.h}px)`);
        });
      });
  }

  // Gera report HTML
  generateHtmlReport(results, outputDir);
  console.log(`\n  Report: ${path.resolve(path.join(outputDir, 'diff-report.html'))}`);

  // Salva JSON com dados completos
  fs.writeFileSync(
    path.join(outputDir, 'diff-results.json'),
    JSON.stringify(results, null, 2)
  );
  console.log(`  JSON:   ${path.resolve(path.join(outputDir, 'diff-results.json'))}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

run().catch(err => { console.error('Erro fatal:', err); process.exit(1); });
