const express = require('express');
const path = require('path');
const https = require('https');

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;

const PROXIES = [
  { server: 'http://64.137.96.74:6641' },
  { server: 'http://198.105.121.200:6462' },
  { server: 'http://84.247.60.125:6095' },
  { server: 'http://23.95.150.145:6114' },
  { server: 'http://38.154.203.95:5863' },
];

const CONSENT_SELECTORS = {
  'mobile.de': ['[data-testid="mde-consent-accept-btn"]', '.sp_choice_type_11', 'button[title*="Akzeptieren"]'],
  'autoscout24.com': ['#_evidon-accept-button', 'button[id*="accept-all"]', 'button:has-text("Accept All")'],
  'coches.net': ['#didomi-notice-agree-button'],
};

function getPlatform(url) {
  return Object.keys(CONSENT_SELECTORS).find(p => url.includes(p)) || null;
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

async function scrape(url, platform, proxy) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });

    const ctxOpts = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
      },
    };

    if (proxy && PROXY_USER) {
      ctxOpts.proxy = { server: proxy.server, username: PROXY_USER, password: PROXY_PASS };
    }

    const context = await browser.newContext(ctxOpts);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500 + Math.random() * 1000);

    // Aceitar cookies
    for (const sel of (CONSENT_SELECTORS[platform] || [])) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); await page.waitForTimeout(1500); break; }
      } catch {}
    }

    await page.waitForTimeout(2000);

    const title = await page.title();

    // Extrair imagem principal (og:image ou primeira img relevante)
    const imageUrl = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]')?.content;
      if (og) return og;
      const imgs = Array.from(document.querySelectorAll('img[src]'));
      const big = imgs.find(img => {
        const src = img.src || '';
        return src.includes('http') && !src.includes('logo') && !src.includes('icon') &&
               img.naturalWidth > 200;
      });
      return big?.src || null;
    });

    const bodyText = await page.evaluate(() => {
      document.querySelectorAll('script,style,nav,footer,header,iframe,[class*="cookie"],[id*="cookie"],[class*="consent"],[class*="gdpr"],[class*="overlay"]').forEach(e => e.remove());
      return document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 2).join('\n');
    });

    await browser.close();
    browser = null;

    return { title, bodyText, imageUrl };
  } catch(err) {
    if (browser) await browser.close().catch(()=>{});
    throw err;
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true, hasKey: !!ANTHROPIC_KEY, hasProxy: !!PROXY_USER }));

app.post('/api/simulate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL em falta.' });
  const platform = getPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Plataforma não suportada.' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

  let title, bodyText, imageUrl;

  try {
    if (platform === 'mobile.de' && PROXY_USER) {
      let lastErr;
      for (const proxy of PROXIES) {
        try {
          console.log(`[scrape] mobile.de via ${proxy.server}`);
          const r = await scrape(url, platform, proxy);
          if (r.bodyText.length > 500) { ({ title, bodyText, imageUrl } = r); break; }
          lastErr = new Error('Conteúdo insuficiente');
        } catch(e) { lastErr = e; }
      }
      if (!bodyText) throw lastErr;
    } else {
      console.log(`[scrape] ${platform} → ${url.slice(0, 70)}`);
      const r = await scrape(url, platform, null);
      ({ title, bodyText, imageUrl } = r);
      console.log(`[scrape] OK — ${bodyText.length} chars | img: ${imageUrl ? 'sim' : 'não'}`);
    }
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }

  if (!bodyText || bodyText.length < 300) {
    return res.status(500).json({ error: 'Não foi possível extrair dados do anúncio.' });
  }

  try {
    const prompt = `Analisa estes dados de um anúncio automóvel e calcula a simulação de importação para Portugal.

Plataforma: ${platform}
Título: ${title}
URL: ${url}

CONTEÚDO:
${bodyText.slice(0, 10000)}

ISV PORTUGAL 2025:
- Elétrico puro: 0€
- Híbrido plug-in: redução 60-75%
- Gasolina/Diesel: componente cilindrada + CO2 (tabela AT progressiva)

CUSTOS:
- Transporte: 900-1400€ (conforme país)
- Inspeção e homologação: 280-420€
- Legalização e registo: 380-600€
- Serviço Greenport Select: 2500€ (fixo)

Responde APENAS JSON puro:
{
  "veiculo": {"marca":"","modelo":"","versao":"","ano":0,"dataRegisto":"","quilometros":0,"combustivel":"","potenciaCv":0,"cilindrada":0,"co2GKm":0,"caixa":"","cor":"","pais":""},
  "simulacao": {"valorViatura":0,"isv":0,"isvIsento":false,"transporte":0,"inspecaoHomologacao":0,"legalizacao":0,"servicoGreenport":2500,"totalChaveNaMao":0},
  "notas":["máx 3 notas específicas"]
}`;

    const claudeText = await callClaude(prompt);
    const s = claudeText.indexOf('{');
    const e = claudeText.lastIndexOf('}');
    if (s === -1) throw new Error('Resposta inválida.');

    const result = JSON.parse(claudeText.slice(s, e + 1));
    const sim = result.simulacao;
    const recalc = (sim.valorViatura||0)+(sim.isv||0)+(sim.transporte||0)+(sim.inspecaoHomologacao||0)+(sim.legalizacao||0)+(sim.servicoGreenport||0);
    if (Math.abs(recalc-(sim.totalChaveNaMao||0)) > 100) sim.totalChaveNaMao = recalc;
    result.platform = platform;
    result.imageUrl = imageUrl || null;
    res.json(result);
  } catch(err) {
    console.error('[claude]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Greenport Simulador v4 na porta ${PORT}`));
