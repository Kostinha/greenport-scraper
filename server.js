const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CONSENT = {
  'mobile.de':       '[data-testid="mde-consent-accept-btn"], button[class*="consent-accept"]',
  'autoscout24.com': '#_evidon-accept-button, button[id*="accept-all"]',
  'coches.net':      '#didomi-notice-agree-button',
};

function getPlatform(url) {
  for (const d of Object.keys(CONSENT)) {
    if (url.includes(d)) return d;
  }
  return null;
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.content?.find(b => b.type === 'text')?.text || '';
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: !!ANTHROPIC_KEY });
});

// ── Main simulation endpoint ──────────────────────────────────────────────────
app.post('/api/simulate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL em falta.' });

  const platform = getPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Plataforma não suportada.' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

  let browser;
  try {
    // ── 1. Scraping com browser real ──────────────────────────────────────────
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'pt-PT',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: { 'Accept-Language': 'pt-PT,pt;q=0.9,de;q=0.8,en;q=0.7' },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    console.log(`[scrape] ${platform} → ${url.slice(0, 80)}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });

    try {
      await page.waitForSelector(CONSENT[platform], { timeout: 6000 });
      await page.click(CONSENT[platform]);
      await page.waitForTimeout(2000);
    } catch { /* sem popup */ }

    await page.waitForTimeout(2500);

    const title = await page.title();
    const bodyText = await page.evaluate(() => {
      document.querySelectorAll('script,style,nav,footer,header,iframe,[class*="cookie"],[id*="cookie"],[class*="consent"],[class*="banner"]').forEach(e => e.remove());
      return document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 1).join('\n');
    });

    await browser.close();
    browser = null;
    console.log(`[scrape] OK — ${bodyText.length} chars`);

    // ── 2. Claude analisa e calcula ───────────────────────────────────────────
    const prompt = `Analisa estes dados extraídos de um anúncio automóvel e calcula a simulação de importação para Portugal.

Plataforma: ${platform}
Título: ${title}
URL: ${url}

CONTEÚDO:
${bodyText.slice(0, 10000)}

CÁLCULO ISV PORTUGAL 2025:
- Elétrico puro: ISV = 0€
- Híbrido plug-in: redução 60-75% sobre ISV base
- Gasolina/Diesel/Mild Hybrid: componente cilindrada + componente CO2 (tabela progressiva AT)

OUTROS CUSTOS:
- Transporte: 900-1400€ conforme país
- Inspeção e homologação: 280-420€
- Legalização e registo: 380-600€
- Serviço Greenport Select: 2500€ (fixo)
- Total = viatura + ISV + transporte + inspeção + legalização + serviço

Responde APENAS JSON puro:
{
  "veiculo": {
    "marca": "", "modelo": "", "versao": "", "ano": 0,
    "dataRegisto": "", "quilometros": 0, "combustivel": "",
    "potenciaCv": 0, "cilindrada": 0, "co2GKm": 0,
    "caixa": "", "cor": "", "pais": ""
  },
  "simulacao": {
    "valorViatura": 0, "isv": 0, "isvIsento": false,
    "transporte": 0, "inspecaoHomologacao": 0, "legalizacao": 0,
    "servicoGreenport": 2500, "totalChaveNaMao": 0
  },
  "notas": ["máx 3 notas específicas sobre este veículo"]
}`;

    const claudeText = await callClaude(prompt);
    const s = claudeText.indexOf('{');
    const e = claudeText.lastIndexOf('}');
    if (s === -1) throw new Error('Resposta inválida do Claude');

    const result = JSON.parse(claudeText.slice(s, e + 1));

    // Recalcular total
    const sim = result.simulacao;
    const recalc = (sim.valorViatura||0)+(sim.isv||0)+(sim.transporte||0)+(sim.inspecaoHomologacao||0)+(sim.legalizacao||0)+(sim.servicoGreenport||0);
    if (Math.abs(recalc - (sim.totalChaveNaMao||0)) > 100) sim.totalChaveNaMao = recalc;

    result.platform = platform;
    res.json(result);

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[simulate] ERRO:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Servir frontend
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Greenport Simulador activo na porta ${PORT}`));
