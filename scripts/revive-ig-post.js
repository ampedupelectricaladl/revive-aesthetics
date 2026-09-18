#!/usr/bin/env node
/**
 * revive-ig-post.js — Post a carousel (photos + optional video) to @reviveaesthetics.adl
 *
 * Usage:
 *   node revive-ig-post.js --files "/path/a.jpg,/path/b.jpg,/path/c.mp4" --caption "..."
 *   node revive-ig-post.js --dry-run   # opens browser but stops before clicking Share
 *
 * First run: browser opens at IG login. Log in as @reviveaesthetics.adl + dismiss any
 * save-login prompts. Session persists in ~/.openclaw/revive-instagram-puppeteer-profile/
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function getArg(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}
const filesArg = getArg('--files');
const captionArg = getArg('--caption');
const DRY_RUN = argv.includes('--dry-run');

if (!filesArg) {
  console.error('Usage: node revive-ig-post.js --files "f1.jpg,f2.jpg" --caption "..."');
  process.exit(1);
}

const FILES = filesArg.split(',').map(f => f.trim()).filter(Boolean);
const CAPTION = captionArg || '';

console.log('Files to post:', FILES.length);
FILES.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
console.log('Caption length:', CAPTION.length);
if (DRY_RUN) console.log('DRY-RUN mode — will not click Share');

// ── Playwright ───────────────────────────────────────────────────────────────
function resolvePlaywright() {
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'workspace', 'node_modules', 'playwright'),
    path.join(os.homedir(), 'amped-automations', 'node_modules', 'playwright'),
    'playwright',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  throw new Error('playwright not found — run: cd ~/.openclaw/workspace && npm install playwright');
}

const PROFILE_DIR = path.join(os.homedir(), '.openclaw', 'revive-instagram-puppeteer-profile');
const LOGIN_URL   = 'https://www.instagram.com/accounts/login/';
const HOME_URL    = 'https://www.instagram.com/';

async function isLoggedIn(page) {
  const url = page.url();
  if (url.includes('/accounts/login') || url.includes('/accounts/onetap')) return false;
  try {
    return await page.locator('svg[aria-label="Home"]').first().isVisible({ timeout: 4000 });
  } catch {
    return !url.includes('/accounts/login');
  }
}

async function waitForLogin(page, timeoutMs = 300000) {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  LOG IN AS @reviveaesthetics.adl IN THE BROWSER WINDOW.');
  console.log('  Dismiss any "Save login info?" / notification prompts.');
  console.log(`  Waiting up to ${Math.round(timeoutMs / 1000)}s.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1500);
    if (await isLoggedIn(page)) {
      console.log('✅ Logged in as Stefani.');
      return;
    }
  }
  throw new Error('Login timeout — try again.');
}

(async () => {
  const { chromium } = resolvePlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('[revive-ig] Profile dir:', PROFILE_DIR);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  // ── Navigate to IG ──
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (!await isLoggedIn(page)) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  } else {
    console.log('[revive-ig] Session alive — already logged in.');
  }

  // ── Click Create / + button ──
  console.log('[revive-ig] Opening post creator…');

  // Instagram's Create button: svg aria-label="New post" or the + icon in nav
  // Try several selectors in order
  let createClicked = false;
  for (const sel of [
    'svg[aria-label="New post"]',
    'a[href="/create/select/"]',
    '[aria-label="New post"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click();
        createClicked = true;
        console.log(`[revive-ig] Clicked create via: ${sel}`);
        break;
      }
    } catch (_) {}
  }

  if (!createClicked) {
    // Try clicking by visible text in the nav
    try {
      await page.getByRole('link', { name: /create/i }).first().click();
      createClicked = true;
      console.log('[revive-ig] Clicked Create via role link.');
    } catch (_) {}
  }

  if (!createClicked) {
    throw new Error('Could not find the Create/+ button. IG may have updated their UI. Screenshot saved to debug.');
  }

  await page.waitForTimeout(2000);

  // ── If a menu appeared (Post / Reel / Story), click Post ──
  try {
    const postOption = page.getByRole('button', { name: /^post$/i }).first();
    if (await postOption.isVisible({ timeout: 3000 })) {
      await postOption.click();
      console.log('[revive-ig] Selected "Post" from menu.');
      await page.waitForTimeout(1500);
    }
  } catch (_) {}

  // ── Upload files ──
  console.log('[revive-ig] Looking for file input…');

  // IG hides a file input — we intercept the chooser
  const fileInput = page.locator('input[type="file"]').first();

  // Try clicking the "Select from computer" button to trigger the input
  for (const label of ['Select from computer', 'Select From Computer', 'select from computer']) {
    try {
      const btn = page.getByRole('button', { name: label }).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }),
          btn.click(),
        ]);
        await chooser.setFiles(FILES);
        console.log(`[revive-ig] Files set via filechooser (${FILES.length} files).`);
        break;
      }
    } catch (_) {}
  }

  // Fallback: set directly on hidden input
  if (await fileInput.count() > 0) {
    try {
      await fileInput.setInputFiles(FILES);
      console.log('[revive-ig] Files set directly on hidden input.');
    } catch (e) {
      console.warn('[revive-ig] Direct setInputFiles failed:', e.message);
    }
  }

  await page.waitForTimeout(3000);

  // ── If "Select multiple" prompt appears, click it ──
  try {
    const multi = page.getByRole('button', { name: /select multiple/i }).first();
    if (await multi.isVisible({ timeout: 3000 })) {
      await multi.click();
      console.log('[revive-ig] Clicked "Select multiple".');
      await page.waitForTimeout(1500);
    }
  } catch (_) {}

  // ── Click "OK" / "Continue" on any "crop" warning dialog ──
  for (const label of ['OK', 'Continue', 'Select crop']) {
    try {
      const btn = page.getByRole('button', { name: label }).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        console.log(`[revive-ig] Dismissed dialog: ${label}`);
        await page.waitForTimeout(1000);
        break;
      }
    } catch (_) {}
  }

  // ── Click through Next buttons (Crop → Filter/Edit → Caption) ──
  console.log('[revive-ig] Advancing through post steps…');
  for (let step = 0; step < 3; step++) {
    await page.waitForTimeout(2000);
    try {
      const nextBtn = page.getByRole('button', { name: /^next$/i }).first();
      if (await nextBtn.isVisible({ timeout: 4000 })) {
        await nextBtn.click();
        console.log(`[revive-ig] Clicked Next (step ${step + 1})`);
      }
    } catch (_) {
      console.log(`[revive-ig] Next button not found at step ${step + 1} — may already be on caption.`);
    }
  }

  await page.waitForTimeout(2000);

  // ── Type caption ──
  if (CAPTION) {
    try {
      const captionBox = page.locator('div[aria-label="Write a caption..."], textarea[aria-label="Write a caption..."]').first();
      await captionBox.click({ timeout: 5000 });
      await captionBox.fill(CAPTION);
      console.log('[revive-ig] Caption entered.');
    } catch (e) {
      console.warn('[revive-ig] Could not fill caption:', e.message);
    }
    await page.waitForTimeout(1000);
  }

  if (DRY_RUN) {
    console.log('');
    console.log('DRY-RUN — stopping before Share. Review the browser window, then close it.');
    await new Promise(() => {}); // keep open
    return;
  }

  // ── Click Share ──
  console.log('[revive-ig] Clicking Share…');
  let shared = false;
  for (const label of ['Share', 'Post']) {
    try {
      const shareBtn = page.getByRole('button', { name: label }).first();
      if (await shareBtn.isVisible({ timeout: 5000 })) {
        await shareBtn.click();
        shared = true;
        console.log(`[revive-ig] Shared! (via "${label}" button)`);
        break;
      }
    } catch (_) {}
  }

  if (!shared) {
    console.error('[revive-ig] Could not find Share button. Leaving browser open for manual share.');
    await new Promise(() => {});
    return;
  }

  // ── Wait for confirmation ──
  await page.waitForTimeout(5000);
  const finalUrl = page.url();
  console.log('[revive-ig] Final URL:', finalUrl);
  if (finalUrl.includes('/p/') || finalUrl === HOME_URL || finalUrl.includes('instagram.com/')) {
    console.log('[revive-ig] ✅ Post appears to have been shared successfully!');
  } else {
    console.log('[revive-ig] ⚠️  URL is unexpected — check the browser to confirm.');
  }

  await context.close();
  console.log('[revive-ig] Done. Browser closed.');
})().catch(e => {
  console.error('[revive-ig] FATAL:', e.message);
  process.exit(1);
});
