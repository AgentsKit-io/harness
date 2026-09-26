// Real-browser check of the public site's AgentsKit shell v1 adoption (bar, Star, flow hero, tour, footer, aurora).
// Needs a served site (HARNESS_SITE_URL, default http://localhost:3005) and a shell origin serving /shell/v1.*.
// ponytail: Playwright is not a harness dependency; resolve it from PLAYWRIGHT_RESOLVE_FROM (a sibling checkout); the check fails closed without it.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'

const root = process.cwd()
const baseURL = process.env.HARNESS_SITE_URL ?? 'http://localhost:3005'
const outDir = resolve(process.env.HARNESS_UI_OUTPUT_DIR ?? '.codex/verification/site-shell')
const copyDir = process.env.HARNESS_UI_COPY_DIR
const repo = 'https://github.com/AgentsKit-io/harness'
const criteria = ['harness-site-shell']
const failures = []
const results = []
const artifacts = []
const check = (id, passed, detail) => { results.push({ id, status: passed ? 'passed' : 'failed', detail }); if (!passed) failures.push(`${id}: ${detail}`) }
const finish = () => {
  console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', criteria, capability: 'real-browser', baseURL, artifacts, results, failures }))
  if (failures.length) process.exitCode = 1
}

let chromium
try {
  const require = createRequire(join(resolve(process.env.PLAYWRIGHT_RESOLVE_FROM ?? root), 'package.json'))
  chromium = require('@playwright/test').chromium
} catch (error) {
  check('playwright', false, `cannot load @playwright/test (set PLAYWRIGHT_RESOLVE_FROM): ${error.message}`)
  finish()
  process.exit()
}

mkdirSync(outDir, { recursive: true })
if (copyDir) mkdirSync(copyDir, { recursive: true })
let browser
try {
  // PLAYWRIGHT_CHANNEL=chrome uses the installed Chrome when Playwright's own browser build is missing.
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
} catch (error) {
  check('browser', false, `cannot launch Chromium: ${error.message.split('\n')[0]}`)
  finish()
  process.exit()
}
try {
  const schemes = (process.env.HARNESS_UI_COLOR_SCHEMES ?? 'light,dark').split(',')
  const runs = schemes.flatMap(scheme => [['desktop', { width: 1440, height: 960 }], ['mobile', { width: 390, height: 844 }]].map(([device, viewport]) => [`${device}-${scheme}`, viewport, scheme, device]))
  for (const [name, viewport, colorScheme, device] of runs) {
    const page = await browser.newPage({ viewport, colorScheme, reducedMotion: 'no-preference' })
    // HARNESS_SHELL_DIR serves /shell/v1.* from a local checkout (agentskit/apps/docs-next/public/shell) before it is hosted.
    if (process.env.HARNESS_SHELL_DIR) await page.route(/\/shell\/v1\.(js|css)(\?.*)?$/, route => route.fulfill({ path: join(resolve(process.env.HARNESS_SHELL_DIR), new URL(route.request().url()).pathname.split('/').pop()), headers: { 'access-control-allow-origin': '*' } }))
    const errors = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    const response = await page.goto(`${baseURL}/`, { waitUntil: 'networkidle', timeout: 45000 })
    check(`${name}:status`, response?.status() === 200, `HTTP ${response?.status()}`)
    await page.waitForFunction(() => customElements.get('agentskit-footer') && customElements.get('agentskit-aurora') && customElements.get('agentskit-ecosystem'), null, { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const data = await page.evaluate(repoUrl => {
      const first = document.body.firstElementChild
      const bar = document.getElementById('ak-eco') ?? first
      const anchors = [...document.querySelectorAll('a'), ...(bar?.shadowRoot ? bar.shadowRoot.querySelectorAll('a') : [])]
      const stars = anchors.filter(a => /\bstar\b/i.test(a.textContent ?? '') || /\bstar\b/i.test(a.getAttribute('aria-label') ?? ''))
      const inBar = a => Boolean(bar) && (bar.contains(a) || a.getRootNode() === bar.shadowRoot)
      const aurora = document.querySelector('agentskit-aurora')
      const auroraStyle = aurora ? getComputedStyle(aurora) : null
      const footer = document.querySelector('agentskit-footer')
      const tour = document.querySelector('agentskit-ecosystem')
      // Shell elements may render into a shadow root (the tour does) or replace their light-DOM fallback.
      const text = el => ((el?.shadowRoot ?? el)?.textContent ?? '').replace(/\s+/g, ' ')
      const upgraded = (el, fallback) => Boolean(el) && (Boolean(el.shadowRoot) || !el.querySelector(fallback))
      const links = el => [...(el?.shadowRoot ?? el ?? document.createElement('i')).querySelectorAll('a')]
      return {
        barAtTop: Boolean(bar) && bar.getBoundingClientRect().top <= 1 && bar !== document.querySelector('.harness-home'),
        barProducts: ['AgentsKit', 'Registry', 'Chat', 'Doc Bridge', 'Code Review', 'Harness'].filter(name => text(bar).includes(name)),
        barHasPlaybook: /Playbook/.test(text(bar)),
        starInBar: stars.filter(inBar).map(a => a.href),
        starOutsideBar: stars.filter(a => !inBar(a)).map(a => a.href),
        repoUrl,
        flowFigure: Boolean(document.querySelector('.harness-home svg[data-figure]')),
        heroTitle: text(document.querySelector('.harness-home h1')),
        wordmark: (() => { const brand = document.querySelector('.harness-home-header .ak-product-wordmark__brand'); return Boolean(brand) && getComputedStyle(brand).color !== 'rgb(13, 17, 23)' })(),
        tourUpgraded: upgraded(tour, '.harness-ecosystem-fallback'),
        tourCurrent: tour?.getAttribute('current'),
        tourHasPlaybook: /Playbook/.test(text(tour)),
        footerUpgraded: upgraded(footer, '.ak-footer-fallback'),
        footerLinks: links(footer).length,
        aurora: Boolean(aurora) && auroraStyle?.position === 'fixed' && auroraStyle.pointerEvents === 'none' && aurora.getAttribute('aria-hidden') === 'true',
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }
    }, repo)
    check(`${name}:bar`, data.barAtTop && data.barProducts.length === 6 && !data.barHasPlaybook, `top=${data.barAtTop} products=${data.barProducts.join(',')} playbook=${data.barHasPlaybook}`)
    check(`${name}:star`, data.starInBar.some(href => href.replace(/\/$/, '') === repo) && data.starOutsideBar.length === 0, `inBar=${data.starInBar.join(',')} outside=${data.starOutsideBar.join(',')}`)
    check(`${name}:flow-hero`, data.flowFigure && /Harness/.test(data.heroTitle) && data.wordmark, `figure=${data.flowFigure} h1=${data.heroTitle} wordmark=${data.wordmark}`)
    check(`${name}:tour`, data.tourUpgraded && data.tourCurrent === 'harness' && !data.tourHasPlaybook, `upgraded=${data.tourUpgraded} current=${data.tourCurrent} playbook=${data.tourHasPlaybook}`)
    check(`${name}:footer`, data.footerUpgraded && data.footerLinks > 0, `upgraded=${data.footerUpgraded} links=${data.footerLinks}`)
    check(`${name}:aurora`, data.aurora, 'fixed, aria-hidden, pointer-events:none')
    check(`${name}:overflow`, data.overflow <= 0, `horizontal overflow ${data.overflow}px`)
    check(`${name}:console`, errors.length === 0, errors.join(' | ') || 'no console errors')
    // Hero title contrast (WCAG AA, large text >= 3:1) against the pixels actually rendered behind it (aurora included).
    const title = page.locator('.harness-home h1 + p')
    const box = await title.boundingBox()
    const fg = await title.evaluate(el => getComputedStyle(el).color)
    await title.evaluate(el => { el.dataset.prevColor = el.style.color; el.style.color = 'transparent' })
    const bgShot = box ? (await page.screenshot({ clip: box })).toString('base64') : ''
    await title.evaluate(el => { el.style.color = el.dataset.prevColor ?? '' })
    const ratio = await page.evaluate(async ({ png, fg }) => {
      if (!png) return 0
      const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode()
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, img.width, img.height).data
      const lum = ([r, g, b]) => [r, g, b].map(v => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
      const f = lum(fg.match(/[\d.]+/g).slice(0, 3).map(Number))
      const ratios = []
      for (let i = 0; i < data.length; i += 16) { const b = lum([data[i], data[i + 1], data[i + 2]]); ratios.push((Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05)) }
      ratios.sort((a, b) => a - b)
      return ratios[Math.floor(ratios.length * 0.05)] // worst 5% of background pixels
    }, { png: bgShot, fg })
    check(`${name}:hero-contrast`, ratio >= 3, `title ${fg} worst-5% contrast ${ratio.toFixed(2)}:1 (AA large >= 3)`)
    const path = join(outDir, `home-${name}.png`)
    await page.screenshot({ path, fullPage: true })
    artifacts.push({ path: relative(root, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), type: 'screenshot', viewport })
    if (copyDir) copyFileSync(path, join(copyDir, `home-${name}.png`))
    if (device === 'desktop') {
      const docs = await page.goto(`${baseURL}/docs/`, { waitUntil: 'networkidle', timeout: 45000 })
      await page.waitForTimeout(800)
      const wordmark = await page.evaluate(() => Boolean(document.querySelector('.ak-product-wordmark')))
      check(`docs-${colorScheme}:wordmark`, docs?.status() === 200 && wordmark, `HTTP ${docs?.status()} wordmark=${wordmark}`)
      const docsPath = join(outDir, `docs-${name}.png`)
      await page.screenshot({ path: docsPath })
      artifacts.push({ path: relative(root, docsPath), sha256: createHash('sha256').update(readFileSync(docsPath)).digest('hex'), type: 'screenshot', viewport })
      if (copyDir) copyFileSync(docsPath, join(copyDir, `docs-${name}.png`))
    }
    await page.close()
  }
} finally {
  await browser.close()
}
finish()
