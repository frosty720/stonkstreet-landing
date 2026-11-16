/* GREED's market numbers, read straight from Base: the price from GREED's own pool, GMEc's dollar price from GeckoTerminal,
   and from those the dollar price, market cap and pool liquidity. Each visitor's browser asks; nothing goes through our servers.
   A plain script (not a module) so the static host needs nothing special; it sets window.GreedMarket. */
(function (global) {
	'use strict';

	const GREED = '0xcbbaf485817b174a01e29b012e6e85435765d0a7';
	const GME = '0xb2000000000000000000007790ed6e48e06ed935';
	const POOL = '0x6e9d3d023333f713671adef499aa3c9f7c0b227d';
	/** GMEc is the pool's token0 (its address sorts first), GREED its token1 (read on Base, 2026-11-16). */
	const GME_DECIMALS = 8;
	const GREED_DECIMALS = 18;
	const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
	const GME_PRICE_URL = 'https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/' + GME;
	const REFRESH_MS = 60000;
	const TIMEOUT_MS = 8000;

	const SLOT0 = '0x3850c7bd';
	const TOTAL_SUPPLY = '0x18160ddd';
	const BALANCE_OF = '0x70a08231';

	/** GMEc per GREED from the pool's sqrtPriceX96, which prices token1 (GREED) in token0 (GMEc) units, inverted. */
	function gmePerGreed(sqrtPriceX96) {
		const ratio = Number(sqrtPriceX96) / 2 ** 96;
		const greedPerGmeRaw = ratio * ratio;
		if (!(greedPerGmeRaw > 0)) return 0;
		const greedPerGme = greedPerGmeRaw * 10 ** (GME_DECIMALS - GREED_DECIMALS);
		return 1 / greedPerGme;
	}

	function units(raw, decimals) {
		return Number(raw) / 10 ** decimals;
	}

	/** The numbers shown, from the chain's raw answers and GMEc's dollar price. */
	function summarize(read) {
		const priceGme = gmePerGreed(read.sqrtPriceX96);
		const priceUsd = priceGme * read.gmeUsd;
		return {
			priceGme: priceGme,
			priceUsd: priceUsd,
			marketCapUsd: units(read.totalSupply, GREED_DECIMALS) * priceUsd,
			liquidityUsd: units(read.poolGreed, GREED_DECIMALS) * priceUsd + units(read.poolGme, GME_DECIMALS) * read.gmeUsd,
		};
	}

	/** Under a dollar: three significant digits, so a tiny price still reads. A dollar or more: whole cents, or whole dollars past $1,000. */
	function formatUsd(value, locale) {
		if (!(value > 0) || !Number.isFinite(value)) return '—';
		const options = { style: 'currency', currency: 'USD' };
		if (value < 1) options.maximumSignificantDigits = 3;
		else options.maximumFractionDigits = value >= 1000 ? 0 : 2;
		return new Intl.NumberFormat(locale, options).format(value);
	}

	function word(hex, index) {
		const start = 2 + index * 64;
		return BigInt('0x' + hex.slice(start, start + 64));
	}

	function withTimeout(fetcher, url, init) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		return fetcher(url, Object.assign({}, init, { signal: controller.signal })).finally(() => clearTimeout(timer));
	}

	async function ethCall(fetcher, rpc, to, data) {
		const res = await withTimeout(fetcher, rpc, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: to, data: data }, 'latest'] }),
		});
		if (!res.ok) throw new Error('rpc status ' + res.status);
		const body = await res.json();
		if (body.error || typeof body.result !== 'string' || body.result.length < 66) throw new Error('rpc refused the call');
		return body.result;
	}

	function balanceOf(holder) {
		return BALANCE_OF + holder.slice(2).padStart(64, '0');
	}

	/** One RPC's answers, all four or none. */
	async function readChain(fetcher, rpc) {
		const answers = await Promise.all([
			ethCall(fetcher, rpc, POOL, SLOT0),
			ethCall(fetcher, rpc, GREED, TOTAL_SUPPLY),
			ethCall(fetcher, rpc, GREED, balanceOf(POOL)),
			ethCall(fetcher, rpc, GME, balanceOf(POOL)),
		]);
		return { sqrtPriceX96: word(answers[0], 0), totalSupply: word(answers[1], 0), poolGreed: word(answers[2], 0), poolGme: word(answers[3], 0) };
	}

	async function readGmeUsd(fetcher) {
		const res = await withTimeout(fetcher, GME_PRICE_URL, {});
		if (!res.ok) throw new Error('price status ' + res.status);
		const body = await res.json();
		const price = Number(body.data.attributes.token_prices[GME]);
		if (!(price > 0)) throw new Error('no GMEc price');
		return price;
	}

	/** Tries each public RPC in turn; the dollar price comes from GeckoTerminal alongside. */
	async function read(fetcher) {
		const gmeUsd = readGmeUsd(fetcher);
		let lastError;
		for (const rpc of RPCS) {
			try {
				const chain = await readChain(fetcher, rpc);
				return Object.assign(chain, { gmeUsd: await gmeUsd });
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError;
	}

	/**
	 * Fills `[data-market=price|cap|liquidity|updated]` inside `root` and shows it, then refreshes every minute. A failed read
	 * shows a dash rather than old or zero numbers. `words.updated` and `words.unavailable` are the page's own language.
	 */
	function mount(root, locale, words, fetcher) {
		const fetchFn = fetcher || global.fetch.bind(global);
		const field = (name) => root.querySelector('[data-market="' + name + '"]');
		const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
		root.hidden = false;
		async function refresh() {
			try {
				const numbers = summarize(await read(fetchFn));
				field('price').textContent = formatUsd(numbers.priceUsd, locale);
				field('cap').textContent = formatUsd(numbers.marketCapUsd, locale);
				field('liquidity').textContent = formatUsd(numbers.liquidityUsd, locale);
				field('updated').textContent = words.updated + ' ' + time.format(new Date());
			} catch (error) {
				for (const name of ['price', 'cap', 'liquidity']) field(name).textContent = '—';
				field('updated').textContent = words.unavailable;
			}
		}
		refresh();
		return setInterval(refresh, REFRESH_MS);
	}

	global.GreedMarket = { gmePerGreed: gmePerGreed, summarize: summarize, formatUsd: formatUsd, read: read, mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
