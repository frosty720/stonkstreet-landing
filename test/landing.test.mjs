// Run with: node --test
// The page is one static file, so these read it as text, then load it in headless Chrome to check the launch switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const spanish = readFileSync(join(root, 'es/index.html'), 'utf8');
const X = 'https://x.com/StonkStreetMeme';
const PLAY = 'https://play.stonkstreet.exchange';
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

const anchors = (page) => [...page.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, text]) => ({ attrs, text: text.replace(/<[^>]+>/g, '').trim(), href: /href="([^"]*)"/.exec(attrs)?.[1] }));
const playButtons = (page) => anchors(page).filter((a) => /\bdata-play\b/.test(a.attrs));
const isHidden = (page, marker) => new RegExp(`<[a-z]+[^>]*\\b${marker}\\b[^>]*\\bhidden\\b`).test(page);

/** The page as Chrome leaves it after its script has run, with `edit` applied to the launch switch first. */
function rendered(edit, page = html) {
	const dir = mkdtempSync(join(tmpdir(), 'landing-'));
	const file = join(dir, 'index.html');
	writeFileSync(file, edit(page));
	return execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=2000', '--dump-dom', `file://${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

test('before launch no link leads to the game, which is down: every Play button points to X and says so', () => {
	assert.match(html, /live: false,/);
	const links = anchors(html);
	assert.deepEqual(links.filter((a) => a.href?.startsWith(PLAY)), []);
	const play = playButtons(html);
	assert.equal(play.length, 4);
	for (const a of play) assert.equal(a.href, X);
	assert.deepEqual(play.map((a) => a.text), ['SOON', 'OPENS AT LAUNCH', 'OPENS AT LAUNCH', 'Opens at launch']);
	assert.equal(isHidden(html, 'data-prelaunch'), false);
	assert.equal(isHidden(html, 'data-live'), true);
});

test('X is linked from the nav, the hero line and the footer, and a shared link shows the large picture', () => {
	assert.equal(anchors(html).filter((a) => a.href === X && !/data-play/.test(a.attrs)).length, 3);
	assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
	assert.match(html, /<meta name="twitter:site" content="@StonkStreetMeme">/);
	assert.match(html, /<meta property="og:image" content="https:\/\/stonkstreet\.exchange\/assets\/hero-exchange-floor\.jpg">/);
	assert.ok(existsSync(join(root, 'assets/hero-exchange-floor.jpg')));
});

test('the page shows the game itself: a real screenshot of the trade desk, sized so the page does not jump as it loads', () => {
	const shot = /<img class="shot" src="(assets\/[^"]+)" width="(\d+)" height="(\d+)" alt="([^"]+)"/.exec(html);
	assert.ok(shot, 'no game screenshot on the page');
	assert.ok(existsSync(join(root, shot[1])));
	assert.match(shot[4], /trade desk/);
	// Its stated size is the file's real size (a JPEG's size sits after the first SOF0 or SOF2 marker).
	const bytes = readFileSync(join(root, shot[1]));
	let at = 2;
	while (bytes[at + 1] !== 0xc0 && bytes[at + 1] !== 0xc2) at += 2 + bytes.readUInt16BE(at + 2);
	assert.deepEqual([bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)], [Number(shot[2]), Number(shot[3])]);
	// A screenshot is not pixel art: it must not be drawn with the page's pixelated scaling.
	assert.match(html, /\.shot\{image-rendering:auto\}/);
});

test('Telegram is linked: the news channel from the hero line and the footer, the chat group from the footer', () => {
	const hrefs = anchors(html).map((a) => a.href);
	assert.equal(hrefs.filter((h) => h === 'https://t.me/stonkstreetmeme').length, 2);
	assert.equal(hrefs.filter((h) => h === 'https://t.me/stonkstreetexchange').length, 1);
	const footer = html.slice(html.indexOf('<nav aria-label="Footer"'));
	assert.deepEqual(anchors(footer).filter((a) => a.href?.startsWith('https://t.me/')).map((a) => a.text), ['Telegram news', 'Telegram chat']);
	// Outside links open in a new tab without handing the new page a way back to this one.
	for (const a of anchors(html).filter((a) => a.href?.startsWith('https://t.me/'))) assert.match(a.attrs, /target="_blank" rel="noopener"/);
});

test('GREED is explained: the holds, the GME pair and where a payment goes, which adds up to all of it', () => {
	const greed = html.slice(html.indexOf('<section id="greed"'), html.indexOf('<section id="prizes"'));
	for (const words of ['100,000 GREED', '1,000,000 GREED', 'GME on Base', 'Paying in GREED sends it straight to the treasury.']) assert.ok(greed.includes(words), words);
	const shares = [...greed.matchAll(/<dd class="num" style="margin: 0">(\d+)%<\/dd>/g)].map((m) => Number(m[1]));
	assert.deepEqual(shares, [50, 40, 10]);
	assert.equal(shares.reduce((a, b) => a + b), 100);
	// Before the coin exists the address slot says so, and the buy button is not on show.
	assert.equal(isHidden(html, 'data-greed-pending'), false);
	assert.equal(isHidden(html, 'data-greed-live'), true);
	assert.match(html, /\[hidden\]\{display:none !important\}/);
});

test('prizes lists the five pots with the shares the game pays, which add up to all of it', () => {
	const prizes = html.slice(html.indexOf('<section id="prizes"'), html.indexOf('<section id="roadmap"'));
	const rows = [...prizes.matchAll(/<tr><th scope="row"[^>]*>([^<]+)<\/th><td[^>]*>([^<]+)<\/td><td[^>]*>(\d+)%<\/td><\/tr>/g)].map((m) => [m[1], Number(m[3])]);
	assert.deepEqual(rows, [['Weekly top 10', 50], ['Monthly league', 20], ['3-month league', 20], ['IPO award', 5], ['Builder reward', 5]]);
	assert.equal(rows.reduce((sum, [, share]) => sum + share, 0), 100);
});

test('the roadmap shows launch and the next three levels, with the seven after that folded away', () => {
	const roadmap = html.slice(html.indexOf('<section id="roadmap"'), html.indexOf('<section id="play"'));
	const [shown, folded] = roadmap.split('<details>');
	const levels = (part) => [...part.matchAll(/flex: none">(\d\d)<\/span>/g)].map((m) => m[1]);
	assert.ok(shown.includes('LEVEL 0'));
	assert.deepEqual(levels(shown), ['01', '02', '03']);
	assert.deepEqual(levels(folded), ['04', '05', '06', '07', '08', '09', '10']);
	assert.ok(folded.includes('SHOW THE 7 LEVELS AFTER THAT'));
});

test('the page reads in the game\'s faces, not the old terminal one', () => {
	assert.equal(html.includes('VT323'), false);
	assert.match(html, /family=IBM\+Plex\+Mono[^"]*family=IBM\+Plex\+Sans[^"]*family=Press\+Start\+2P/);
});

test('flipping the switch to live turns every Play button into a real link to the game', { skip: !CHROME && 'no Chrome to load the page in' }, () => {
	const page = rendered((h) => h.replace('live: false,', 'live: true,'));
	const play = playButtons(page);
	assert.equal(play.length, 4);
	for (const a of play) {
		assert.equal(a.href, PLAY);
		assert.equal(/target=/.test(a.attrs), false);
	}
	assert.deepEqual(play.map((a) => a.text), ['▶ PLAY', '▶ PLAY NOW', '▶ PLAY NOW', 'Play']);
	assert.equal(isHidden(page, 'data-prelaunch'), true);
	assert.equal(isHidden(page, 'data-live'), false);
});

test('left alone, the switch changes nothing', { skip: !CHROME && 'no Chrome to load the page in' }, () => {
	const page = rendered((h) => h);
	for (const a of playButtons(page)) assert.equal(a.href, X);
	assert.equal(isHidden(page, 'data-greed-live'), true);
});

test('a contract address shows it with a buy link; without a buy link the button stays hidden', { skip: !CHROME && 'no Chrome to load the page in' }, () => {
	const address = '0x1111111111111111111111111111111111111111';
	const withBoth = rendered((h) => h.replace("greedAddress: '',", `greedAddress: '${address}',`).replace("greedBuyUrl: '',", "greedBuyUrl: 'https://example.com/buy',"));
	assert.equal(isHidden(withBoth, 'data-greed-pending'), true);
	assert.equal(isHidden(withBoth, 'data-greed-live'), false);
	assert.match(withBoth, new RegExp(`data-greed-address[^>]*>${address}<`));
	assert.match(withBoth, /data-greed-buy[^>]*href="https:\/\/example\.com\/buy"/);
	assert.equal(isHidden(withBoth, 'data-greed-buy'), false);
	const addressOnly = rendered((h) => h.replace("greedAddress: '',", `greedAddress: '${address}',`));
	assert.equal(isHidden(addressOnly, 'data-greed-live'), false);
	assert.equal(isHidden(addressOnly, 'data-greed-buy'), true);
});

// The Spanish page (owner 2026-11-15) is a translated copy at /es/. These keep it from drifting away from the English one.
/** Every tag in order with its styling, which no translation touches. */
const skeleton = (page) => [...page.matchAll(/<(\/?[a-z0-9]+)\b([^>]*)>/g)].map(([, tag, attrs]) => `${tag} ${/style="([^"]*)"/.exec(attrs)?.[1] ?? ''}`);
/** The words on show, without the script and the styles. */
const words = (page) => page.replace(/<(script|style)[\s\S]*?<\/\1>/g, '').split(/<[^>]+>/).map((t) => t.trim()).filter(Boolean);
const launchSwitch = (page) => /const LAUNCH = \{[\s\S]*?\};/.exec(page)?.[0];

test('the Spanish page is the English page translated: the same build, tag for tag', () => {
	assert.match(spanish, /<html lang="es">/);
	assert.deepEqual(skeleton(spanish), skeleton(html));
});

test('the Spanish page leaves nothing in English but names, numbers and the coin', () => {
	const kept = new Set(words(html).filter((t) => words(spanish).includes(t)));
	const names = ['STONKSTREET', 'StonkStreet', 'STONKSTREET EXCHANGE', 'MR. GREED', 'GREED', '@StonkStreetMeme', 'Telegram', '■'];
	assert.deepEqual([...kept].filter((t) => !names.includes(t) && !/^[\d,]+%?$/.test(t)), []);
});

test('the Spanish page states the same numbers as the English one, in the same order', () => {
	// Colombian Spanish groups thousands with a point where English uses a comma.
	const numbers = (page) => words(page).join(' ').match(/\d[\d.,]*\d%?|\d%?/g).map((n) => n.replace(/[.,]/g, ''));
	assert.deepEqual(numbers(spanish), numbers(html));
	assert.ok(words(spanish).includes('100.000 GREED') && words(spanish).includes('1.000.000 GREED'));
});

test('each language links to the other, and tells search engines about both', () => {
	for (const page of [html, spanish]) {
		assert.match(page, /<link rel="alternate" hreflang="en" href="https:\/\/stonkstreet\.exchange\/">/);
		assert.match(page, /<link rel="alternate" hreflang="es" href="https:\/\/stonkstreet\.exchange\/es\/">/);
	}
	assert.deepEqual(anchors(html).filter((a) => /hreflang/.test(a.attrs)).map((a) => [a.href, a.text]), [['es/', 'ESPAÑOL']]);
	assert.deepEqual(anchors(spanish).filter((a) => /hreflang/.test(a.attrs)).map((a) => [a.href, a.text]), [['../', 'ENGLISH']]);
	assert.match(spanish, /<meta property="og:url" content="https:\/\/stonkstreet\.exchange\/es\/">/);
});

test('the Spanish page finds its pictures from one folder down', () => {
	const pictures = [...spanish.matchAll(/<img[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
	assert.equal(pictures.length, 3);
	for (const src of pictures) assert.ok(existsSync(join(root, 'es', src)), src);
});

test('both pages carry the same launch switch, so one can never be flipped without the other', () => {
	assert.ok(launchSwitch(html));
	assert.equal(launchSwitch(spanish), launchSwitch(html));
});

test('before launch the Spanish Play buttons point to X too, and say so in Spanish', () => {
	const play = playButtons(spanish);
	for (const a of play) assert.equal(a.href, X);
	assert.deepEqual(play.map((a) => a.text), ['PRONTO', 'ABRE EN EL LANZAMIENTO', 'ABRE EN EL LANZAMIENTO', 'Abre en el lanzamiento']);
	assert.deepEqual(anchors(spanish).filter((a) => a.href?.startsWith(PLAY)), []);
});

test('flipping the switch on the Spanish page turns its Play buttons into real links, labelled in Spanish', { skip: !CHROME && 'no Chrome to load the page in' }, () => {
	const page = rendered((h) => h.replace('live: false,', 'live: true,'), spanish);
	const play = playButtons(page);
	for (const a of play) assert.equal(a.href, PLAY);
	assert.deepEqual(play.map((a) => a.text), ['▶ JUGAR', '▶ JUGAR YA', '▶ JUGAR YA', 'Jugar']);
	assert.equal(isHidden(page, 'data-prelaunch'), true);
	assert.equal(isHidden(page, 'data-live'), false);
});

test('accented capitals in the pixel face come from the patch font, on both pages', () => {
	for (const [page, dir] of [[html, '.'], [spanish, 'es']]) {
		const face = /@font-face\{font-family:'StonkStreet Pixel Caps';src:url\(([^)]+)\)[^}]*unicode-range:([^;]+);/.exec(page);
		assert.ok(face, 'no patch font declared');
		assert.ok(existsSync(join(root, dir, face[1])), face[1]);
		// Only the accented capitals, so every other letter still comes from the pixel face itself.
		assert.equal(face[2], 'U+C1,U+C9,U+CD,U+D1,U+D3,U+DA,U+DC');
		assert.match(page, /\[style\*="Press Start 2P"\]\{font-family:'StonkStreet Pixel Caps','Press Start 2P',monospace !important\}/);
	}
});

// How to Play lives on this site too (owner 2026-11-15), so a visitor can read the rules before connecting a wallet.
const guide = readFileSync(join(root, 'how-to-play/index.html'), 'utf8');
const guideSpanish = readFileSync(join(root, 'es/como-jugar/index.html'), 'utf8');
const sections = (page) => [...page.matchAll(/<article[^>]*>\n<h2[^>]*>([^<]+)<\/h2>([\s\S]*?)<\/article>/g)].map(([, title, body]) => [title, body.match(/<p /g).length]);

test('each home page links to the full rules in its own language', () => {
	assert.deepEqual(anchors(html).filter((a) => a.href === 'how-to-play/').map((a) => a.text), ['READ ALL THE RULES']);
	assert.deepEqual(anchors(spanish).filter((a) => a.href === 'como-jugar/').map((a) => a.text), ['LEE TODAS LAS REGLAS']);
});

test('the rules page has the nine sections, in English and in Spanish, with the same number of lines in each', () => {
	assert.deepEqual(sections(guide).map(([title]) => title), ['Cash and the paycheck', 'Trading moves prices', 'The economy', 'New listings', 'Taking control', 'The CEO desk', 'Dirty plays and getting caught', 'Seasons and prizes', 'GREED']);
	assert.equal(sections(guideSpanish).length, 9);
	assert.deepEqual(sections(guideSpanish).map(([, lines]) => lines), sections(guide).map(([, lines]) => lines));
	assert.match(guide, /<html lang="en">/);
	assert.match(guideSpanish, /<html lang="es">/);
	assert.match(guideSpanish, /<h1[^>]*>CÓMO JUGAR<\/h1>/);
});

test('the Spanish rules leave nothing in English, and say the game itself is still in English', () => {
	const kept = words(guide).filter((t) => words(guideSpanish).includes(t));
	assert.deepEqual(kept.filter((t) => !['STONKSTREET', 'GREED'].includes(t)), []);
	assert.match(guideSpanish, /data-note[^>]*>Por ahora el juego está en inglés/);
	assert.equal(/data-note/.test(guide), false);
});

test('the rules name no tunable numbers, so they never go stale against the game', () => {
	for (const page of [guide, guideSpanish]) assert.equal(/\d/.test(sections(page).length && page.slice(page.indexOf('<main'), page.indexOf('</main>')).replace(/<[^>]+>/g, '')), false);
});

test('the rules pages find their way: home, the other language, pictures and the accent font', () => {
	for (const [page, dir, home, other] of [[guide, 'how-to-play', '../', '../es/como-jugar/'], [guideSpanish, 'es/como-jugar', '../', '../../how-to-play/']]) {
		const links = anchors(page).map((a) => a.href);
		assert.deepEqual([...new Set(links)].sort(), [home, other].sort());
		for (const href of [home, other]) assert.ok(existsSync(join(root, dir, href, 'index.html')), href);
		const picture = /<img src="([^"]+)"/.exec(page)[1];
		assert.ok(existsSync(join(root, dir, picture)), picture);
		const font = /src:url\(([^)]+)\)/.exec(page)[1];
		assert.ok(existsSync(join(root, dir, font)), font);
		assert.match(page, /<link rel="alternate" hreflang="en" href="https:\/\/stonkstreet\.exchange\/how-to-play\/">/);
		assert.match(page, /<link rel="alternate" hreflang="es" href="https:\/\/stonkstreet\.exchange\/es\/como-jugar\/">/);
	}
	// No Play button here, so the launch switch stays in the two home pages only.
	for (const page of [guide, guideSpanish]) assert.equal(/data-play|LAUNCH/.test(page), false);
});
