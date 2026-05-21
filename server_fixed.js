const express = require('express');
const path = require('path');
const https = require('https');

// ── Playwright com Stealth Plugin ─────────────────────────────────────────────
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Selectores de cookie consent por plataforma ───────────────────────────────
const CONSENT_SELECTORS = {
  'mobile.de': [
    '[data-testid="mde-consent-accept-btn"]',
    'button[class*="accept"]',
    'button[id*="accept"]',
    '.sp_choice_type_11',
    'button:has-text("Aceitar")',
    'button:has-text("Akzeptieren")',
    'button:has-text("Accept")',
  ],
  'autoscout24.com': [
    '#_evidon-accept-button',
    'button[id*="accept-all"]',
    '[data-testid="accept-all-btn"]',
    'button:has-text("Accept All")',
    'button:has-text("Alle akzeptieren")',
  ],
  'coches.net': [
    '#didomi-notice-agree-button',
    '.didomi-accept',
    'button:has-text("Acepto")',
  ],
};

function getPlatform(url) {
  const platforms = Object.keys(CONSENT_SELECTORS);
  return platforms.find(p => url.includes(p)) || null;
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
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message));
          resolve(p.content?.find(b => b.type === 'text')?.text || '');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, hasKey: !!ANTHROPIC_KEY }));

// ── Simulate ──────────────────────────────────────────────────────────────────
app.post('/api/simulate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL em falta.' });
  const platform = getPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Plataforma não suportada.' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

  let browser;
  try {
    // ── 1. Abrir browser com stealth ──────────────────────────────────────────
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1366,768',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1366, height: 768 },
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      extraHTTPHeaders: {
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    // Script de stealth adicional
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['de-DE','de','en'] });
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
      const orig = window.navigator.permissions.query;
      window.navigator.permissions.query = p =>
        p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(p);
    });

    const page = await context.newPage();

    // Visitar a página principal primeiro (comportamento humano)
    if (platform === 'mobile.de') {
      await page.goto('https://www.mobile.de', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500 + Math.random() * 1000);
    }

    console.log(`[scrape] ${platform} → ${url.slice(0, 80)}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2000 + Math.random() * 1500);

    // Tentar aceitar cookies com vários selectores
    const selectors = CONSENT_SELECTORS[platform] || [];
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          console.log(`[consent] Clicado: ${sel}`);
          await page.waitForTimeout(1500);
          break;
        }
      } catch {}
    }

    // Aguardar conteúdo dinâmico
    await page.waitForTimeout(3000);

    const title = await page.title();
    const bodyText = await page.evaluate(() => {
      document.querySelectorAll('script,style,nav,footer,header,iframe,[class*="cookie"],[id*="cookie"],[class*="consent"],[class*="gdpr"],[class*="banner"],[class*="overlay"]').forEach(e => e.remove());
      return document.body.innerText
        .split('\n').map(l => l.trim()).filter(l => l.length > 2).join('\n');
    });

    await browser.close();
    browser = null;

    if (bodyText.length < 200) {
      throw new Error('Acesso negado pela plataforma. Conteúdo insuficiente extraído.');
    }

    console.log(`[scrape] OK — ${bodyText.length} chars`);

    // ── 2. Claude analisa ─────────────────────────────────────────────────────
    const prompt = `Analisa estes dados de um anúncio automóvel e calcula a simulação de importação para Portugal.

Plataforma: ${platform}
Título da página: ${title}
URL: ${url}

CONTEÚDO DO ANÚNCIO:
${bodyText.slice(0, 10000)}

CÁLCULO ISV PORTUGAL 2025:
- Elétrico puro: ISV = 0€
- Híbrido plug-in: redução 60-75% sobre ISV base
- Gasolina/Diesel: componente cilindrada + componente CO2 (tabela progressiva AT)

OUTROS CUSTOS:
- Transporte: 900-1400€ conforme país de origem
- Inspeção e homologação: 280-420€
- Legalização e registo: 380-600€
- Serviço Greenport Select: 2500€ (fixo)
- Total = viatura + ISV + transporte + inspeção + legalização + serviço

Responde APENAS JSON puro sem nada antes ou depois:
{
  "veiculo": {
    "marca":"","modelo":"","versao":"","ano":0,
    "dataRegisto":"","quilometros":0,"combustivel":"",
    "potenciaCv":0,"cilindrada":0,"co2GKm":0,
    "caixa":"","cor":"","pais":""
  },
  "simulacao": {
    "valorViatura":0,"isv":0,"isvIsento":false,
    "transporte":0,"inspecaoHomologacao":0,"legalizacao":0,
    "servicoGreenport":2500,"totalChaveNaMao":0
  },
  "notas":["máx 3 notas específicas sobre este veículo"]
}`;

    const claudeText = await callClaude(prompt);
    const s = claudeText.indexOf('{');
    const e = claudeText.lastIndexOf('}');
    if (s === -1) throw new Error('Resposta inválida do Claude.');

    const result = JSON.parse(claudeText.slice(s, e + 1));
    const sim = result.simulacao;
    const recalc = (sim.valorViatura||0)+(sim.isv||0)+(sim.transporte||0)+(sim.inspecaoHomologacao||0)+(sim.legalizacao||0)+(sim.servicoGreenport||0);
    if (Math.abs(recalc-(sim.totalChaveNaMao||0)) > 100) sim.totalChaveNaMao = recalc;

    result.platform = platform;
    res.json(result);

  } catch (err) {
    if (browser) await browser.close().catch(()=>{});
    console.error('[simulate] ERRO:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Greenport Simulador v2 activo na porta ${PORT}`));
