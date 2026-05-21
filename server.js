const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Cookie consent selectors por plataforma ──────────────────────────────────
const CONSENT = {
  'mobile.de':      '[data-testid="mde-consent-accept-btn"], .mde-consent-accept-btn, button[id*="accept"]',
  'autoscout24.com':'#_evidon-accept-button, button[id*="accept-all"], [data-testid="accept-all-btn"]',
  'coches.net':     '#didomi-notice-agree-button, .didomi-accept, button[id*="agree"]',
};

function getPlatform(url) {
  for (const domain of Object.keys(CONSENT)) {
    if (url.includes(domain)) return domain;
  }
  return null;
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Greenport Scraper' }));

// ── Scrape endpoint ───────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL em falta.' });

  const platform = getPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Plataforma não suportada.' });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'pt-PT',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: { 'Accept-Language': 'pt-PT,pt;q=0.9,de;q=0.8,en;q=0.7' },
    });

    // Ocultar webdriver flag
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();

    console.log(`[scrape] ${platform} → ${url.slice(0, 80)}…`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aceitar cookies se aparecerem
    try {
      await page.waitForSelector(CONSENT[platform], { timeout: 6000 });
      await page.click(CONSENT[platform]);
      console.log('[scrape] Cookie consent aceite');
      await page.waitForTimeout(2000);
    } catch {
      console.log('[scrape] Sem popup de cookies (ou já aceite)');
    }

    // Aguardar carregamento de conteúdo dinâmico
    await page.waitForTimeout(2500);

    const title = await page.title();

    // Extrair texto limpo (sem scripts, estilos, anúncios)
    const bodyText = await page.evaluate(() => {
      const remove = document.querySelectorAll(
        'script, style, nav, footer, header, iframe, ' +
        '[class*="cookie"], [id*="cookie"], [class*="consent"], ' +
        '[class*="banner"], [class*="sidebar"], [class*="advert"]'
      );
      remove.forEach(el => el.remove());
      return document.body.innerText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 1)
        .join('\n');
    });

    await browser.close();
    browser = null;

    console.log(`[scrape] OK — ${bodyText.length} chars extraídos`);

    res.json({
      ok: true,
      platform,
      title,
      text: bodyText.slice(0, 12000),
      url,
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[scrape] ERRO:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Greenport Scraper activo na porta ${PORT}`));
