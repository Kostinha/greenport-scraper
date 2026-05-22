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

// ── CALCULADORA ISV — TABELAS AT 2025/2026 ────────────────────────────────────
function calcularISV(v) {
  const { combustivel, cilindrada, co2GKm, dataRegisto } = v;

  const fuel = (combustivel || '').toLowerCase();
  const cc = Number(cilindrada) || 0;
  const co2 = Number(co2GKm) || 0;

  // Elétrico puro — isento
  if (fuel.includes('elétric') || fuel.includes('electr') || fuel.includes('bev')) {
    return { isv: 0, isvIsento: true };
  }

  // Determinar norma (WLTP para veículos >= 2020)
  const ano = dataRegisto
    ? parseInt(dataRegisto.split('/').pop() || dataRegisto)
    : (Number(v.ano) || 2022);
  const isWLTP = ano >= 2020;
  const isDiesel = fuel.includes('diesel') || fuel.includes('gasóleo') || fuel.includes('gasoleo');
  const isPhev = fuel.includes('plug') || fuel.includes('phev');
  const isMildHybrid = (fuel.includes('híbrido') || fuel.includes('hybrid')) && !isPhev;

  // ── Componente cilindrada (tabela igual para todos os combustíveis) ──────────
  let cCilindrada = 0;
  if (cc > 0) {
    if (cc <= 1000) cCilindrada = cc * 1.09 - 849.03;
    else if (cc <= 1250) cCilindrada = cc * 1.18 - 850.69;
    else cCilindrada = cc * 5.61 - 6194.88;
    cCilindrada = Math.max(0, cCilindrada);
  }

  // ── Componente ambiental CO2 ─────────────────────────────────────────────────
  let cCo2 = 0;
  if (co2 > 0) {
    if (isDiesel) {
      // Diesel: converter WLTP para NEDC equivalente (factor 1.21) e usar tabela NEDC
      // Tabelas AT confirmadas — impostosobreveiculos.info
      const co2Calc = isWLTP ? co2 / 1.21 : co2;
      if (co2Calc <= 79)       cCo2 = co2Calc * 5.78 - 439.04;
      else if (co2Calc <= 95)  cCo2 = co2Calc * 23.45 - 1848.58;
      else if (co2Calc <= 120) cCo2 = co2Calc * 79.22 - 7195.63;
      else if (co2Calc <= 140) cCo2 = co2Calc * 175.73 - 18924.92;
      else if (co2Calc <= 160) cCo2 = co2Calc * 195.43 - 21720.92;
      else                      cCo2 = co2Calc * 268.42 - 33447.90;
    } else if (isWLTP) {
      // Gasolina/GPL WLTP — tabela AT 2025/2026
      if (co2 <= 110)       cCo2 = co2 * 0.44 - 43.02;
      else if (co2 <= 115)  cCo2 = co2 * 1.10 - 115.80;
      else if (co2 <= 120)  cCo2 = co2 * 1.38 - 147.79;
      else if (co2 <= 130)  cCo2 = co2 * 5.27 - 619.17;
      else if (co2 <= 145)  cCo2 = co2 * 6.38 - 762.73;
      else if (co2 <= 175)  cCo2 = co2 * 41.54 - 5819.56;
      else if (co2 <= 195)  cCo2 = co2 * 51.38 - 7247.39;
      else if (co2 <= 235)  cCo2 = co2 * 193.01 - 34190.52;
      else                   cCo2 = co2 * 233.81 - 41910.96;
    } else {
      // Gasolina/GPL NEDC — tabela AT 2025/2026
      if (co2 <= 99)        cCo2 = co2 * 4.62 - 427.00;
      else if (co2 <= 115)  cCo2 = co2 * 8.09 - 750.99;
      else if (co2 <= 145)  cCo2 = co2 * 52.56 - 5903.94;
      else if (co2 <= 175)  cCo2 = co2 * 61.24 - 7140.17;
      else if (co2 <= 195)  cCo2 = co2 * 155.97 - 23627.27;
      else                   cCo2 = co2 * 205.65 - 33390.12;
    }
    cCo2 = Math.max(0, cCo2);
  }

  let isvBase = cCilindrada + cCo2;

  // ── Reduções por tipo de veículo ─────────────────────────────────────────────
  if (isPhev) {
    isvBase *= 0.25; // Híbrido plug-in: paga só 25%
  } else if (isMildHybrid) {
    isvBase *= 0.60; // Mild hybrid / full hybrid: paga 60%
  }

  // ── Desconto por idade (usados UE) — Tabela unificada desde 2025 ─────────────
  // Fonte: AutoGo.pt / Autoridade Tributária
  let descontoIdade = 0;
  if (dataRegisto) {
    const parts = dataRegisto.split('/');
    const regMes = parts.length >= 2 ? parseInt(parts[0]) : 1;
    const regAno = parseInt(parts[parts.length - 1]);
    if (!isNaN(regAno)) {
      const now = new Date();
      const ageMonths = (now.getFullYear() - regAno) * 12 + (now.getMonth() + 1 - regMes);
      const ageYears = ageMonths / 12;
      if      (ageYears <= 1)  descontoIdade = 0.10;
      else if (ageYears <= 2)  descontoIdade = 0.20;
      else if (ageYears <= 3)  descontoIdade = 0.28;
      else if (ageYears <= 4)  descontoIdade = 0.35;
      else if (ageYears <= 5)  descontoIdade = 0.43;
      else if (ageYears <= 6)  descontoIdade = 0.52;
      else if (ageYears <= 7)  descontoIdade = 0.60;
      else if (ageYears <= 8)  descontoIdade = 0.65;
      else if (ageYears <= 9)  descontoIdade = 0.70;
      else if (ageYears <= 10) descontoIdade = 0.75;
      else                      descontoIdade = 0.80;
    }
  }
  isvBase *= (1 - descontoIdade);

  // ── Agravamento diesel (partículas) — 500€ sobre o ISV já reduzido ───────────
  // Aplicado após redução de idade (é uma taxa fixa, não percentual)
  if (isDiesel && !isPhev) isvBase += 500;

  return { isv: Math.max(100, Math.round(isvBase)), isvIsento: false };
}

// ── Claude API ────────────────────────────────────────────────────────────────
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
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

// ── Scraping ──────────────────────────────────────────────────────────────────
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

    for (const sel of (CONSENT_SELECTORS[platform] || [])) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); await page.waitForTimeout(1500); break; }
      } catch {}
    }

    await page.waitForTimeout(2000);

    const title = await page.title();
    const imageUrl = await page.evaluate(() => {
      return document.querySelector('meta[property="og:image"]')?.content || null;
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

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, hasKey: !!ANTHROPIC_KEY }));

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
      console.log(`[scrape] OK — ${bodyText.length} chars`);
    }
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }

  if (!bodyText || bodyText.length < 300) {
    return res.status(500).json({ error: 'Não foi possível extrair dados do anúncio.' });
  }

  try {
    // Claude extrai APENAS dados do veículo — NÃO calcula ISV
    const prompt = `Extrai os dados deste anúncio de automóvel. NÃO calcules ISV, impostos ou custos — só os dados do veículo.

Título: ${title}
Plataforma: ${platform}
URL: ${url}

CONTEÚDO:
${bodyText.slice(0, 9000)}

Responde APENAS JSON puro:
{
  "marca": "",
  "modelo": "",
  "versao": "",
  "ano": 0,
  "dataRegisto": "MM/AAAA",
  "quilometros": 0,
  "combustivel": "Diesel|Gasolina|Elétrico|Híbrido Plug-in|Híbrido",
  "potenciaCv": 0,
  "cilindrada": 0,
  "co2GKm": 0,
  "caixa": "Automática|Manual",
  "cor": "",
  "pais": "",
  "precoOrigem": 0,
  "notas": ["máx 3 notas específicas sobre este veículo — equipamento, estado, garantia, etc."]
}`;

    const claudeText = await callClaude(prompt);
    const s = claudeText.indexOf('{');
    const e = claudeText.lastIndexOf('}');
    if (s === -1) throw new Error('Resposta inválida.');

    const veiculo = JSON.parse(claudeText.slice(s, e + 1));
    const notas = veiculo.notas || [];
    delete veiculo.notas;

    // ── ISV calculado server-side com tabelas AT 2025/2026 ──────────────────────
    const { isv, isvIsento } = calcularISV(veiculo);

    // ── Custos estimados ────────────────────────────────────────────────────────
    const pais = (veiculo.pais || '').toLowerCase();
    const transporte = pais.includes('alem') || pais.includes('german') ? 1100
      : pais.includes('fran') ? 950
      : pais.includes('ital') ? 1200
      : pais.includes('espanh') || pais.includes('spain') ? 900
      : 1100;
    const inspecaoHomologacao = 350;
    const legalizacao = 500;
    const servicoGreenport = 2500;

    const valorViatura = veiculo.precoOrigem || 0;
    const totalChaveNaMao = valorViatura + isv + transporte + inspecaoHomologacao + legalizacao + servicoGreenport;

    const result = {
      veiculo,
      simulacao: {
        valorViatura,
        isv,
        isvIsento,
        transporte,
        inspecaoHomologacao,
        legalizacao,
        servicoGreenport,
        totalChaveNaMao,
      },
      notas,
      platform,
      imageUrl: imageUrl || null,
    };

    res.json(result);

  } catch(err) {
    console.error('[claude]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Greenport Simulador v5 — ISV server-side — porta ${PORT}`));
