/**
 * ONE-SHOT strictly READ-ONLY real-x DOM inspection (authorized for m2-fix-extraction-semantics).
 *
 * Question: does the real reply composer visibly expose that THE VIEWER FOLLOWS THE REPLY TARGET?
 *
 * Read-only guarantees (AGENTS.md boundaries):
 * - Navigation and DOM reads only. The only interaction is focusing the reply composer textbox
 *   (locator.focus()) — strictly less than typing, which AGENTS.md already permits.
 * - NEVER clicks Post or any post/like/follow/repost control; never types; nothing is submitted.
 * - Output is STRUCTURAL FACTS ONLY: data-testids, roles, badge-word classifications. No post
 *   text, no handles, no URLs, no cookies/keys are ever printed.
 *
 * Exit codes: 0 ok, 2 missing cookies, 3 session challenged, 1 error (caller decides on the
 * single allowed retry).
 */
import { chromium } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;

function readEnvValuesRedacted() {
  const raw = readFileSync(join(REPO, '.env.local'), 'utf8');
  const values = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return values;
}

function composerRegionFacts(page) {
  return page.evaluate(() => {
    // Badge-word classifier for UI labels only (EN + the account's PT-BR labels). The words
    // themselves are never printed — only their class.
    const VOCAB = [
      ['follow', /\b(following|follows you|follow back)\b|seguindo|segue você|segue vc|te segue/i],
      ['like', /\bliked by|curtido por\b/i],
      ['repost', /\breposted by|repostado por\b/i],
    ];
    const classifyBadgeWord = (text) => {
      for (const [kind, pattern] of VOCAB) if (pattern.test(text)) return kind;
      return 'other';
    };

    const composer = document.querySelector(
      'div[data-testid^="tweetTextarea_"][role="textbox"][contenteditable="true"]',
    );
    if (!composer) return { composerFound: false };

    const ancestorChain = [];
    let ancestor = composer.parentElement;
    for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
      const testid = ancestor.getAttribute?.('data-testid') ?? null;
      ancestorChain.push(ancestor.tagName.toLowerCase() + (testid ? `[${testid}]` : ''));
    }

    // Mirror the extraction's region: parent of the *RichTextInputContainer (or composer parent).
    const container = composer.closest('[data-testid$="RichTextInputContainer"]');
    const region = (container ?? composer).parentElement ?? composer;

    const testids = new Set();
    for (const element of region.querySelectorAll('[data-testid]')) {
      testids.add(element.getAttribute('data-testid'));
    }

    // Follow-related candidates: any node whose testid mentions follow/social, plus any VISIBLE
    // node whose own (direct-text) content matches follow vocabulary. Only structure is returned.
    const followMarkers = [];
    for (const element of region.querySelectorAll('[data-testid]')) {
      const testid = element.getAttribute('data-testid') ?? '';
      if (/follow|social/i.test(testid)) followMarkers.push({ via: 'testid', testid });
    }
    const isVisible = (element) => {
      let node = element;
      while (node) {
        if (node.hasAttribute?.('hidden')) return false;
        const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        node = node.parentElement;
      }
      return true;
    };
    for (const element of region.querySelectorAll('*')) {
      if (!isVisible(element)) continue;
      const ownText = [...element.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join('')
        .trim();
      if (!ownText) continue;
      if (/follow|segu/i.test(ownText)) {
        followMarkers.push({ via: 'text', testid: element.getAttribute('data-testid'), kind: classifyBadgeWord(ownText) });
      }
    }

    // The reply-context chip structure (what extraction binds to); handle never recorded.
    let replyChip = null;
    for (const link of region.querySelectorAll('a[href^="/"][role="link"]')) {
      if (!(link.textContent ?? '').trim().startsWith('@')) continue;
      const chip = link.closest('div') ?? link;
      replyChip = {
        present: true,
        chipTestid: chip.getAttribute('data-testid'),
        innerTestid: chip.querySelector('[data-testid]')?.getAttribute('data-testid') ?? null,
        linkDirectChildOfRegion: link.parentElement === region,
      };
      break;
    }

    return {
      composerFound: true,
      composerTestid: composer.getAttribute('data-testid'),
      ancestorChain,
      regionTestids: [...testids].sort(),
      followMarkers,
      replyChip,
    };
  });
}

async function main() {
  const env = readEnvValuesRedacted();
  const authToken = env.get('X_AUTH_TOKEN');
  const ct0 = env.get('X_CT0');
  if (!authToken || !ct0) {
    console.log('RESULT: missing-cookies');
    process.exit(2);
  }

  const profile = mkdtempSync(join(tmpdir(), 'amplifyx-realx-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);

  const out = {};

  // 1. Session check on home.
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const homeComposer = page.locator('div[data-testid="tweetTextarea_0"][role="textbox"][contenteditable="true"]');
  const composerAppeared = await homeComposer
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true, () => false);
  if (!composerAppeared) {
    console.log('RESULT: session-challenged (no home composer after load)');
    await context.close();
    process.exit(3);
  }
  out.session = 'ok';
  out.home = { composer0: true };

  // 2. Following tab (in-network reply targets); status links counted, never recorded.
  await page.goto('https://x.com/home?tab=following', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  out.followingTab = {
    statusLinks: await page.evaluate(() => (document.querySelector('a[href*="/status/"]') ? 'found' : 'none')),
  };

  // 3. Timeline badge vocabulary on the following feed (structural only: testid + word class).
  out.timelineBadges = await page.evaluate(() => {
    const classify = (text) => {
      if (/\b(following|follows you)\b|seguindo|segue você/i.test(text)) return 'follow';
      if (/\bliked by|curtido por\b/i.test(text)) return 'like';
      if (/\breposted by|repostado por\b/i.test(text)) return 'repost';
      return 'other';
    };
    const facts = [];
    for (const badge of document.querySelectorAll('[data-testid="socialContext"], [data-testid="userFollowIndicator"]')) {
      const text = (badge.textContent ?? '').trim();
      facts.push({ testid: badge.getAttribute('data-testid'), classification: text ? classify(text) : 'empty' });
      if (facts.length >= 5) break;
    }
    return facts;
  });

  // 4. Status page (in-network target): reply composer facts, before and after FOCUS only.
  const inNetworkHref = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/status/"]');
    return link ? link.getAttribute('href') : null;
  });
  out.statusInNetwork = await inspectStatusPage(page, inNetworkHref, { focus: true });

  // 5. For You tab (likely out-of-network target): same status-page inspection.
  await page.goto('https://x.com/home?tab=foryou', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const forYouHref = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/status/"]');
    return link ? link.getAttribute('href') : null;
  });
  out.statusOutOfNetwork = await inspectStatusPage(page, forYouHref, { focus: false });

  console.log('RESULT: ok');
  console.log(JSON.stringify(out, null, 2));
  await context.close();
  process.exit(0);
}

/** Navigates to a status page (path only, never recorded) and dumps composer-region facts. */
async function inspectStatusPage(page, statusPath, { focus }) {
  if (!statusPath) return { error: 'no status link found on the tab' };
  await page.goto(`https://x.com${statusPath}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const replyComposer = page
    .locator('div[data-testid^="tweetTextarea_"][role="textbox"][contenteditable="true"]')
    .first();
  const appeared = await replyComposer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
  if (!appeared) return { error: 'no reply composer on status page' };
  const facts = { beforeFocus: await composerRegionFacts(page) };
  if (focus) {
    await replyComposer.focus(); // focus ONLY — never typed, never submitted
    await page.waitForTimeout(2_000);
    facts.afterFocus = await composerRegionFacts(page);
  }
  return facts;
}

main().catch((error) => {
  console.log('RESULT: error');
  console.log(String(error).split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
