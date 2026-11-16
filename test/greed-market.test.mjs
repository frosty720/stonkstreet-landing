// Run with: node --test
// Loads assets/greed-market.js the way a page does (a plain script that sets window.GreedMarket) and checks its maths
// and its handling of the RPCs and GeckoTerminal with stubbed answers. Nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'assets/greed-market.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const spanish = readFileSync(join(root, 'es/index.html'), 'utf8');

const GREED = '0xcbbaf485817b174a01e29b012e6e85435765d0a7';
const GME = '0xb2000000000000000000007790ed6e48e06ed935';
const POOL = '0x6e9d3d023333f713671adef499aa3c9f7c0b227d';

function load() {
	const window = { fetch: () => Promise.reject(new Error('no network in tests')) };
	vm.runInNewContext(source, { window, globalThis: window, AbortController, setTimeout, clearTimeout, setInterval: () => 0, Intl, BigInt, Number, Promise, JSON, Object, Error, Date });
	return window.GreedMarket;
}

/** The pool's sqrtPriceX96 for a price of `greedPerGme` whole GREED per whole GMEc (GMEc is token0 with 8 decimals, GREED token1 with 18). */
function sqrtPriceFor(greedPerGme) {
	const raw = greedPerGme * 1e10;
	return BigInt(Math.round(Math.sqrt(raw) * 2 ** 48)) * 2n ** 48n;
}

const word = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0');

/** A stub fetch: `rpc(url, to, data)` answers each eth_call, and GeckoTerminal answers `gmeUsd`. */
function stubFetch({ rpc, gmeUsd = 27 }) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push(url);
		if (url.includes('geckoterminal')) {
			return { ok: true, json: async () => ({ data: { attributes: { token_prices: { [GME]: String(gmeUsd) } } } }) };
		}
		const { params } = JSON.parse(init.body);
		const result = rpc(url, params[0].to.toLowerCase(), params[0].data);
		if (result instanceof Error) return { ok: false, status: 503, json: async () => ({}) };
		return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
	};
	return { fetch, calls };
}

/** Base as it stood on 2026-11-16: 6.05M GREED per GMEc, 1B supply, 971.7M GREED and 4.54 GMEc in the pool. */
function liveishChain(url, to, data) {
	if (to === POOL) return word(sqrtPriceFor(6_045_870)) + '0'.repeat(64 * 5);
	if (to === GREED && data === '0x18160ddd') return word(10n ** 27n);
	if (to === GREED) return word(971_743_079n * 10n ** 18n);
	if (to === GME) return word(454_168_736n);
	throw new Error(`unexpected call to ${to}`);
}

test('the price in GMEc inverts the pool price and corrects for the 8 and 18 decimals', () => {
	const { gmePerGreed } = load();
	assert.ok(Math.abs(gmePerGreed(sqrtPriceFor(1_000_000)) / 1e-6 - 1) < 1e-9);
	assert.ok(Math.abs(gmePerGreed(sqrtPriceFor(4)) / 0.25 - 1) < 1e-9);
	assert.equal(gmePerGreed(0n), 0);
});

test('price, market cap and liquidity follow from the pool price, the supply, the pool balances and GMEc in dollars', () => {
	const { summarize } = load();
	const s = summarize({ sqrtPriceX96: sqrtPriceFor(1_000_000), totalSupply: 10n ** 27n, poolGreed: 500_000_000n * 10n ** 18n, poolGme: 100_000_000n, gmeUsd: 30 });
	const close = (a, b) => assert.ok(Math.abs(a / b - 1) < 1e-9, `${a} vs ${b}`);
	close(s.priceGme, 1e-6);
	close(s.priceUsd, 3e-5);
	close(s.marketCapUsd, 30_000);
	close(s.liquidityUsd, 500_000_000 * 3e-5 + 30);
});

test('a tiny price keeps three significant digits; larger sums drop the cents past $1,000; nothing becomes $0', () => {
	const { formatUsd } = load();
	assert.equal(formatUsd(0.0000044702, 'en-US'), '$0.00000447');
	assert.equal(formatUsd(4470.2, 'en-US'), '$4,470');
	assert.equal(formatUsd(12.345, 'en-US'), '$12.35');
	assert.equal(formatUsd(0, 'en-US'), '—');
	assert.equal(formatUsd(Number.NaN, 'en-US'), '—');
	assert.match(formatUsd(0.0000044702, 'es-ES'), /^0,00000447\sUS\$$/);
});

test('read gives the numbers from the first public RPC, and GMEc in dollars from GeckoTerminal', async () => {
	const { read, summarize } = load();
	const { fetch } = stubFetch({ rpc: liveishChain, gmeUsd: 27.0263 });
	const s = summarize(await read(fetch));
	assert.ok(Math.abs(s.priceUsd / 0.00000447 - 1) < 0.01, String(s.priceUsd));
	assert.ok(Math.abs(s.marketCapUsd / 4470 - 1) < 0.01, String(s.marketCapUsd));
});

test('when the first RPC fails, read asks the second', async () => {
	const { read } = load();
	const { fetch, calls } = stubFetch({ rpc: (url, to, data) => (url.includes('mainnet.base.org') ? new Error('down') : liveishChain(url, to, data)) });
	const answer = await read(fetch);
	assert.ok(answer.totalSupply > 0n);
	assert.ok(calls.some((url) => url.includes('publicnode')));
});

test('when every source fails, the panel shows dashes and says so instead of old or zero numbers', async () => {
	const { mount } = load();
	const fields = Object.fromEntries(['price', 'cap', 'liquidity', 'updated'].map((name) => [name, { textContent: 'old' }]));
	const panel = { hidden: true, querySelector: (selector) => fields[/data-market="(\w+)"/.exec(selector)[1]] };
	const { fetch } = stubFetch({ rpc: () => new Error('down') });
	mount(panel, 'en-US', { updated: 'Updated', unavailable: 'Prices unavailable right now' }, fetch);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(panel.hidden, false);
	assert.deepEqual([fields.price.textContent, fields.cap.textContent, fields.liquidity.textContent], ['—', '—', '—']);
	assert.equal(fields.updated.textContent, 'Prices unavailable right now');
});

test('both pages load the script, carry the hidden panel with its four fields, and start it in their own language', () => {
	for (const [page, src, locale] of [
		[html, 'assets/greed-market.js', 'en-US'],
		[spanish, '../assets/greed-market.js', 'es-ES'],
	]) {
		assert.ok(page.includes(`<script src="${src}"></script>`));
		assert.match(page, /<div data-greed-market hidden/);
		for (const name of ['price', 'cap', 'liquidity', 'updated']) assert.ok(page.includes(`data-market="${name}"`), name);
		assert.ok(page.includes(`GreedMarket.mount(document.querySelector('[data-greed-market]'), '${locale}'`));
	}
});
