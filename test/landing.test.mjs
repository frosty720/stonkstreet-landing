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
const X = 'https://x.com/StonkStreetMeme';
const PLAY = 'https://play.stonkstreet.exchange';
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

const anchors = (page) => [...page.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, text]) => ({ attrs, text: text.replace(/<[^>]+>/g, '').trim(), href: /href="([^"]*)"/.exec(attrs)?.[1] }));
const playButtons = (page) => anchors(page).filter((a) => /\bdata-play\b/.test(a.attrs));
const isHidden = (page, marker) => new RegExp(`<[a-z]+[^>]*\\b${marker}\\b[^>]*\\bhidden\\b`).test(page);

/** The page as Chrome leaves it after its script has run, with `edit` applied to the launch switch first. */
function rendered(edit) {
	const dir = mkdtempSync(join(tmpdir(), 'landing-'));
	const file = join(dir, 'index.html');
	writeFileSync(file, edit(html));
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

test('GREED is explained: the holds, the GOOGL pair and where a payment goes, which adds up to all of it', () => {
	const greed = html.slice(html.indexOf('<section id="greed"'), html.indexOf('<section id="prizes"'));
	for (const words of ['100,000 GREED', '1,000,000 GREED', 'GOOGL on Base', 'Paying in GREED sends it straight to the treasury.']) assert.ok(greed.includes(words), words);
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
