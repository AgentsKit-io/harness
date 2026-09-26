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
  chromium = (await import(require.resolve('@playwright/test'))).chromium
} catch (error) {
  check('playwright', false, `cannot load @playwright/test (set PLAYWRIGHT_RESOLVE_FROM): ${error.message}`)
  finish()
  process.exit()
}

mkdirSync(outDir, { recursive: true })
if (copyDir) mkdirSync(copyDir, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 960 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' })
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
        wordmark: Boolean(document.querySelector('.harness-home-header .ak-product-wordmark')),
        tourUpgraded: upgraded(tour, '.harness-ecosystem-fallback'),
        tourCurrent: tour?.getAttribute('current'),
        tourHasPlaybook: /Playbook/.test(text(tour)),
        footerUpgraded: upgraded(footer, '.harness-footer-fallback'),
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
    const path = join(outDir, `home-${name}.png`)
    await page.screenshot({ path, fullPage: true })
    artifacts.push({ path: relative(root, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), type: 'screenshot', viewport })
    if (copyDir) copyFileSync(path, join(copyDir, `home-${name}.png`))
    if (name === 'desktop') {
      const docs = await page.goto(`${baseURL}/docs/`, { waitUntil: 'networkidle', timeout: 45000 })
      await page.waitForTimeout(800)
      const wordmark = await page.evaluate(() => Boolean(document.querySelector('.ak-product-wordmark')))
      check('docs:wordmark', docs?.status() === 200 && wordmark, `HTTP ${docs?.status()} wordmark=${wordmark}`)
      const docsPath = join(outDir, 'docs-desktop.png')
      await page.screenshot({ path: docsPath })
      artifacts.push({ path: relative(root, docsPath), sha256: createHash('sha256').update(readFileSync(docsPath)).digest('hex'), type: 'screenshot', viewport })
      if (copyDir) copyFileSync(docsPath, join(copyDir, 'docs-desktop.png'))
    }
    await page.close()
  }
} finally {
  await browser.close()
}
finish()
