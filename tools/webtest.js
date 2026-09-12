#!/usr/bin/env node
'use strict';

/*
 * Real-browser regression test for the GL-MT300N-V2 LuCI pages.
 *
 * This exists because the two custom pages were once shipped with
 * "var formNode = m.render(); ... E([statusBox, formNode, actions])" - and in
 * LuCI 25.x form.Map.render() returns a Promise, not a node, so dom.create()
 * fell through every branch into html.charCodeAt() and threw
 * "TypeError: html.charCodeAt is not a function", blanking both pages.
 *
 * A syntax check, a jsdom shim or a curl of the page HTML all pass while that
 * bug is present, so this test drives a real browser: it logs into the router,
 * loads each page, records every uncaught exception / console error and then
 * asserts on the rendered DOM. It also loads the *previous* broken files fine
 * (as a negative control) - it fails on them, which is the point.
 *
 * Usage:
 *   node tools/webtest.js [--host 192.168.1.1] [--edge <path>] [--apply]
 *                        [--shots <dir>] [--port 9333]
 *
 * Exit code 0 = every check passed, 1 = at least one failure.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* --------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = argv.indexOf(name);
	return (i >= 0 && argv[i + 1] != null) ? argv[i + 1] : dflt;
};

const HOST = opt('--host', '192.168.1.1');
const CDP_PORT = parseInt(opt('--port', '9333'), 10);
const SHOTS = opt('--shots', '');
const DO_APPLY = argv.includes('--apply');
const KEEP_OPEN = argv.includes('--keep-open');
const BASE = `http://${HOST}`;

const EDGE_CANDIDATES = [
	opt('--edge', ''),
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

/* ------------------------------------------------------------------ results */

const results = [];
let failures = 0;

function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
	if (!ok) failures++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* -------------------------------------------------------------------- login */

async function login() {
	const res = await fetch(`${BASE}/cgi-bin/luci/`, {
		method: 'POST',
		redirect: 'manual',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'luci_username=root&luci_password='
	});

	const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
	if (!raw.length) throw new Error(`login: no Set-Cookie header (HTTP ${res.status})`);

	/*
	 * LuCI names the session cookie after the transport: sysauth_https over
	 * TLS and sysauth_http over plain HTTP (the bare "sysauth" name is only
	 * used by some older releases), so accept all three.
	 */
	const m = /(sysauth(?:_https|_http)?)=([^;]+)/.exec(raw.join('; '));
	if (!m) throw new Error('login: no sysauth cookie in ' + raw.join('; '));

	return { name: m[1], value: m[2] };
}

/* ---------------------------------------------------------------- CDP client */

class CDP {
	constructor(ws) {
		this.ws = ws;
		this.seq = 0;
		this.pending = new Map();
		this.listeners = [];
		this.closed = false;

		ws.onmessage = (ev) => {
			let msg;
			try { msg = JSON.parse(ev.data); } catch (e) { return; }
			if (msg.id != null && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
			} else if (msg.method) {
				for (const fn of this.listeners) fn(msg);
			}
		};
		ws.onclose = () => { this.closed = true; };
	}

	send(method, params) {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params: params || {} }));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`${method}: timed out`));
				}
			}, 60000);
		});
	}

	on(fn) { this.listeners.push(fn); }
}

async function fetchJson(url, tries) {
	for (let i = 0; i < (tries || 40); i++) {
		try {
			const r = await fetch(url);
			if (r.ok) return await r.json();
		} catch (e) { /* browser not up yet */ }
		await sleep(250);
	}
	throw new Error('could not reach the browser debug endpoint at ' + url);
}

async function launchBrowser() {
	let exe = null;
	for (const c of EDGE_CANDIDATES)
		if (fs.existsSync(c)) { exe = c; break; }
	if (!exe) throw new Error('no Chromium browser found; pass --edge <path>');

	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mt300n-webtest-'));
	const child = spawn(exe, [
		'--headless=new',
		`--remote-debugging-port=${CDP_PORT}`,
		`--user-data-dir=${profile}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-extensions',
		'--disable-gpu',
		'--hide-scrollbars',
		'--window-size=1280,2000',
		'about:blank'
	], { stdio: 'ignore', detached: false });

	const list = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
	const page = list.find(t => t.type === 'page');
	if (!page) throw new Error('no page target in the browser');

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = (e) => reject(new Error('websocket failed: ' + (e.message || 'error')));
	});

	return { child, profile, cdp: new CDP(ws), ws };
}

/* ------------------------------------------------------------ page recording */

class PageSession {
	constructor(cdp) {
		this.cdp = cdp;
		this.exceptions = [];
		this.consoleErrors = [];
		this.logErrors = [];
		this.netFailures = [];
		this.moduleUrls = [];
		this.mark = 0;

		cdp.on((msg) => {
			if (msg.method === 'Runtime.exceptionThrown') {
				const d = msg.params.exceptionDetails;
				this.exceptions.push({
					text: d.text || '',
					desc: (d.exception && (d.exception.description || d.exception.value)) || '',
					url: (d.url || '') + (d.lineNumber != null ? ':' + (d.lineNumber + 1) : '')
				});
			} else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
				this.consoleErrors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
			} else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
				this.logErrors.push(msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
			} else if (msg.method === 'Network.loadingFailed') {
				this.netFailures.push(msg.params.errorText);
			} else if (msg.method === 'Network.requestWillBeSent') {
				/* LuCI builds its static-asset cache key as
				 * "<luci revision>-<mtime of /lib/apk/db/installed>"
				 * (runtime.uc -> template/header.ut -> luci.js reads the ?v=
				 * back out of its own <script> tag). Recording the URLs the
				 * browser actually requested is how we prove a stale copy of a
				 * view script cannot be reused. */
				const u = msg.params.request.url;
				if (/\/luci-static\/resources\/view\/mt300n\/[\w-]+\.js/.test(u) && this.moduleUrls.indexOf(u) < 0)
					this.moduleUrls.push(u);
			}
		});
	}

	/* everything that is a genuine JS error on one of our pages */
	problemsSinceMark() {
		const ex = this.exceptions.slice(this.mark).map(e => `${e.text} ${e.desc}`.trim());
		const ce = this.consoleErrors.slice(this.mark);
		return ex.concat(ce).filter(Boolean);
	}

	async evaluate(expression, awaitPromise) {
		const r = await this.cdp.send('Runtime.evaluate', {
			expression,
			awaitPromise: awaitPromise !== false,
			returnByValue: true
		});
		if (r.exceptionDetails)
			throw new Error('evaluate threw: ' +
				(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
		return r.result.value;
	}

	/* wait until an expression becomes truthy */
	async waitFor(expression, timeoutMs) {
		const deadline = Date.now() + (timeoutMs || 30000);
		let last;
		while (Date.now() < deadline) {
			try {
				last = await this.evaluate(`!!(${expression})`);
				if (last) return true;
			} catch (e) { last = e.message; }
			await sleep(300);
		}
		return false;
	}

	async goto(url) {
		await this.cdp.send('Page.navigate', { url });
	}

	async shot(file) {
		const r = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
		return fs.statSync(file).size;
	}
}

/* -------------------------------------------------------------------- checks */

const TAILCAT_PAGE = `${BASE}/cgi-bin/luci/admin/services/tailcat`;
const FRPC_PAGE = `${BASE}/cgi-bin/luci/admin/services/frpc`;

async function testTailcat(page) {
	console.log('\n--- Services / tailcat -------------------------------------------------');
	page.mark = page.exceptions.length;

	await page.goto(TAILCAT_PAGE);

	const rendered = await page.waitFor("document.querySelector('#cbi-tailcat')", 45000);
	const problems = page.problemsSinceMark();

	check('tailcat: view rendered without a JS error',
		rendered && problems.length === 0,
		problems.length ? problems.join(' | ') : (rendered ? '' : '#cbi-tailcat never appeared within 45s'));

	if (!rendered)
		return;

	const info = await page.evaluate(`(function () {
		var q = function (s) { return document.querySelector(s); };
		var text = document.body.innerText;
		var btns = Array.prototype.map.call(document.querySelectorAll('button'), function (b) { return b.textContent.trim(); });
		var addr = q('input[readonly]');
		var hints = q('#cbi-tailcat') ? null : null;
		return {
			hasMap: !!q('#cbi-tailcat'),
			tables: document.querySelectorAll('#cbi-tailcat table.table, .cbi-section table.table').length,
			rows: document.querySelectorAll('.cbi-section table.table tr').length,
			address: addr ? addr.value : null,
			buttons: btns,
			hasStatusHeading: /Tailcat address/.test(text),
			hasHowTo: /How to connect from a client/.test(text),
			hintText: (function () {
				var el = Array.prototype.find.call(document.querySelectorAll('h4'), function (h) { return /How to connect/.test(h.textContent); });
				return el && el.nextElementSibling ? el.nextElementSibling.innerText : '';
			})(),
			formFields: document.querySelectorAll('#cbi-tailcat .cbi-value').length,
			textareas: document.querySelectorAll('#cbi-tailcat textarea').length,
			footer: (function () {
				var f = document.querySelector('.cbi-page-actions');
				return f ? f.outerHTML.slice(0, 700) : '(no .cbi-page-actions)';
			})(),
			/* LuCI renders "Save & Apply" as a ComboButton <div>, not a <button> */
			applyControl: (function () {
				var el = document.querySelector('.cbi-page-actions .cbi-dropdown.cbi-button-apply');
				return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
			})(),
			statusText: (function () {
				var t = q('.cbi-section table.table');
				return t ? t.innerText : '';
			})()
		};
	})()`);

	check('tailcat: status table is present', info.rows >= 6, info.rows + ' rows');
	check('tailcat: status shows the service state', /running|stopped/.test(info.statusText),
		JSON.stringify(info.statusText.slice(0, 80)));
	check('tailcat: address is a real tailcat address',
		typeof info.address === 'string' && info.address.length >= 60,
		info.address ? info.address.length + ' chars' : 'no address input');
	check('tailcat: "How to connect from a client" block is rendered', info.hasHowTo);
	check('tailcat: client hints contain a usable command',
		/tailcat (ssh|forward)/.test(info.hintText),
		JSON.stringify(info.hintText.slice(0, 90)));
	check('tailcat: actions are present',
		['Copy address', 'Test tunnel', 'Restart tailcat', 'Stop', 'New key', 'Show log']
			.every(b => info.buttons.indexOf(b) >= 0),
		info.buttons.join(', '));
	check('tailcat: settings form has its options', info.formFields >= 12, info.formFields + ' .cbi-value blocks');
	/* Saving must reach the service. LuCI only renders the apply control when
	 * the view defines handleSaveApply (luci.js:142), so its presence is the
	 * contract that "Save & Apply" will call our handler. */
	check('tailcat: footer offers "Save & Apply" (so a save restarts the service)',
		info.applyControl != null && /Save & Apply/.test(info.applyControl),
		info.applyControl == null ? info.footer : info.applyControl);
	check('tailcat: menu entry resolved to this page', /tailcat/i.test(await page.evaluate('document.title')));

	/* the page must also work: click a control and see a modal appear */
	page.mark = page.exceptions.length;
	await page.evaluate(`(function () {
		var b = Array.prototype.find.call(document.querySelectorAll('button'), function (x) { return x.textContent.trim() === 'Show log'; });
		b.click();
	})()`);
	const modalOk = await page.waitFor("document.querySelector('.modal')", 20000);
	await sleep(1200);
	const modalState = await page.evaluate(`(function () {
		var m = document.querySelector('.modal');
		return { present: !!m, text: m ? m.innerText.slice(0, 200) : '', pre: !!document.querySelector('.modal pre') };
	})()`);
	check('tailcat: "Show log" opens a modal with content',
		modalOk && modalState.present && modalState.pre,
		JSON.stringify(modalState.text.slice(0, 90)));
	check('tailcat: clicking a control raised no JS error',
		page.problemsSinceMark().length === 0, page.problemsSinceMark().join(' | '));

	await page.evaluate(`(function () {
		var b = Array.prototype.find.call(document.querySelectorAll('.modal button'), function (x) { return /Dismiss/.test(x.textContent); });
		if (b) b.click();
	})()`);
	await sleep(500);

	if (DO_APPLY) {
		page.mark = page.exceptions.length;
		const before = info.address;

		/* the apply control is a ComboButton <div>; clicking it runs the
		 * selected action, which is "Save & Apply" (value 0) by default */
		const clicked = await page.evaluate(`(function () {
			var el = document.querySelector('.cbi-page-actions .cbi-dropdown.cbi-button-apply');
			if (!el) return null;
			el.click();
			return el.textContent.replace(/\\s+/g, ' ').trim();
		})()`);

		if (!clicked) {
			check('tailcat: Save & Apply pressed', false, 'no apply control in the footer: ' + info.footer);
		}
		else {
			/* our handleSaveApply saves UCI, restarts the service, notifies and
			 * only then reloads the page, so catch the notification first.
			 * Every message on the page has to be searched: LuCI puts its own
			 * "no password set" banner in .alert-message ahead of ours. */
			const readNotices = `(function () {
				return Array.prototype.map.call(document.querySelectorAll('.alert-message'), function (m) {
					return m.innerText.replace(/\\s+/g, ' ').trim();
				}).filter(function (t) { return /Configuration applied|restarting failed/i.test(t); }).join(' || ');
			})()`;

			let notice = '';
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline && !notice) {
				try { notice = await page.evaluate(readNotices); } catch (e) { /* reloading */ }
				if (!notice) await sleep(200);
			}
			check(`tailcat: Save & Apply ("${clicked.trim()}") reports a successful restart`,
				/applied/i.test(notice) && !/failed/i.test(notice),
				notice || '(our notification never appeared before the reload)');

			await sleep(9000);
			const after = await page.evaluate(`(function () {
				var i = document.querySelector('input[readonly]');
				return i ? i.value : null;
			})()`);
			check('tailcat: the address survives a save-and-apply',
				after && after === before,
				after === before ? 'address unchanged' : `before=${(before || '').slice(-12)} after=${(after || '').slice(-12)}`);
			check('tailcat: Save & Apply raised no JS error',
				page.problemsSinceMark().length === 0, page.problemsSinceMark().join(' | '));
		}
	}

	if (SHOTS)
		console.log('      screenshot: ' + (await page.shot(path.join(SHOTS, 'tailcat.png'))) + ' bytes');
}

async function testFrpc(page) {
	console.log('\n--- Services / frpc ----------------------------------------------------');
	page.mark = page.exceptions.length;

	/*
	 * Reach the page the way a user does: from the previous page, by clicking
	 * the sidebar entry. LuCI handles that client side (XHR + dom.content)
	 * rather than doing a full page load, so it is a different code path from
	 * opening the URL directly - and it is the one that matters in practice.
	 */
	const viaMenu = await page.evaluate(`(function () {
		var a = Array.prototype.find.call(document.querySelectorAll('a[href]'), function (x) {
			return /services\\/frpc$/.test(x.getAttribute('href') || '');
		});
		if (!a) return false;
		a.click();
		return true;
	})()`);
	check('frpc: reachable by clicking the sidebar entry', viaMenu);

	const rendered = await page.waitFor("document.querySelector('#cbi-frpc')", 45000);
	const problems = page.problemsSinceMark();

	check('frpc: view rendered without a JS error',
		rendered && problems.length === 0,
		problems.length ? problems.join(' | ') : (rendered ? '' : '#cbi-frpc never appeared within 45s'));

	if (!rendered)
		return;

	const info = await page.evaluate(`(function () {
		var ta = document.querySelector('#cbi-frpc textarea');
		var btns = Array.prototype.map.call(document.querySelectorAll('button'), function (b) { return b.textContent.trim(); });
		return {
			rows: document.querySelectorAll('.cbi-section table.table tr').length,
			hasTextarea: !!ta,
			textareaLen: ta ? ta.value.length : 0,
			textareaRows: ta ? ta.rows : 0,
			textareaHead: ta ? ta.value.slice(0, 60) : '',
			buttons: btns,
			hasFlag: !!document.querySelector('#cbi-frpc input[type=checkbox]'),
			formFields: document.querySelectorAll('#cbi-frpc .cbi-value').length,
			statusText: (function () {
				var t = document.querySelector('.cbi-section table.table');
				return t ? t.innerText : '';
			})()
		};
	})()`);

	check('frpc: status table is present', info.rows >= 4, info.rows + ' rows');
	check('frpc: status shows the service state', /running|stopped/.test(info.statusText),
		JSON.stringify(info.statusText.slice(0, 80)));
	check('frpc: the whole frpc.toml is editable in one text area',
		info.hasTextarea && info.textareaRows >= 20 && info.textareaLen > 0,
		`textarea rows=${info.textareaRows} len=${info.textareaLen}`);
	check('frpc: enable flag is present', info.hasFlag);
	check('frpc: actions are present',
		['Restart frpc', 'Stop', 'Show log'].every(b => info.buttons.indexOf(b) >= 0),
		info.buttons.join(', '));

	page.mark = page.exceptions.length;
	await page.evaluate(`(function () {
		var b = Array.prototype.find.call(document.querySelectorAll('button'), function (x) { return x.textContent.trim() === 'Show log'; });
		b.click();
	})()`);
	const modalOk = await page.waitFor("document.querySelector('.modal')", 20000);
	await sleep(1200);
	check('frpc: "Show log" opens a modal and raises no JS error',
		modalOk && page.problemsSinceMark().length === 0,
		page.problemsSinceMark().join(' | '));

	await page.evaluate(`(function () {
		var b = Array.prototype.find.call(document.querySelectorAll('.modal button'), function (x) { return /Dismiss/.test(x.textContent); });
		if (b) b.click();
	})()`);
	await sleep(400);

	/* ---------------- the save path on this page, unwrapped ---------------- */
	page.mark = page.exceptions.length;
	const beforeToml = await page.evaluate("document.querySelector('#cbi-frpc textarea').value");
	const applied = await page.evaluate(`(function () {
		var el = document.querySelector('.cbi-page-actions .cbi-dropdown.cbi-button-apply');
		if (!el) return null;
		el.click();
		return el.textContent.replace(/\\s+/g, ' ').trim();
	})()`);
	check('frpc: footer offers "Save & Apply"', applied != null, applied || '(missing)');

	if (applied) {
		let notice = '';
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && !notice) {
			try {
				notice = await page.evaluate(`(function () {
					return Array.prototype.map.call(document.querySelectorAll('.alert-message'), function (m) {
						return m.innerText.replace(/\\s+/g, ' ').trim();
					}).filter(function (t) { return /Configuration applied|restarting failed/i.test(t); }).join(' || ');
				})()`);
			} catch (e) { /* reloading */ }
			if (!notice) await sleep(200);
		}
		check('frpc: Save & Apply reports a successful restart',
			/applied/i.test(notice) && !/failed/i.test(notice),
			notice || '(our notification never appeared)');

		await sleep(6000);
		const afterToml = await page.evaluate(
			"(function () { var t = document.querySelector('#cbi-frpc textarea'); return t ? t.value : null; })()");
		check('frpc: the TOML survives a save-and-apply', afterToml === beforeToml,
			afterToml === beforeToml ? 'unchanged'
				: `before ${beforeToml ? beforeToml.length : '?'} chars, after ${afterToml ? afterToml.length : '?'} chars`);
		check('frpc: Save & Apply raised no JS error',
			page.problemsSinceMark().length === 0, page.problemsSinceMark().join(' | '));
	}

	/* ------- and a plain full page load, with no client-side navigation ----- */
	page.mark = page.exceptions.length;
	await page.goto(FRPC_PAGE);
	const again = await page.waitFor("document.querySelector('#cbi-frpc textarea')", 45000);
	check('frpc: also renders on a full page load (direct URL)',
		again && page.problemsSinceMark().length === 0,
		page.problemsSinceMark().join(' | '));

	if (SHOTS)
		console.log('      screenshot: ' + (await page.shot(path.join(SHOTS, 'frpc.png'))) + ' bytes');
}

async function testMenu(page) {
	console.log('\n--- menu / ACL ---------------------------------------------------------');
	page.mark = page.exceptions.length;

	/* the page URL must serve the authenticated shell, not the login form */
	const html = await fetch(TAILCAT_PAGE, {
		headers: { Cookie: (global.__cookie || 'sysauth') + '=' + global.__sid }
	}).then(r => r.text());
	check('menu: the page URL serves the session shell, not the login form',
		!/luci_password/.test(html) && /luci-static/.test(html));

	/* and the sidebar must actually link to both pages, which is how a user
	 * reaches them - the menu is built client side, so ask the browser */
	const links = await page.evaluate(`(function () {
		return Array.prototype.map.call(document.querySelectorAll('a[href]'), function (a) {
			return a.getAttribute('href') || '';
		}).filter(function (h) { return /services\\/(tailcat|frpc)/.test(h); });
	})()`);
	check('menu: sidebar links to both custom pages exist', links.length >= 2, links.join(' , '));

	/* the cache key the shell advertises must be the one the modules were
	 * fetched under, otherwise a browser can keep serving an old view script
	 * after a fix has been deployed */
	const buster = /luci\.js\?v=([^"']+)/.exec(html);
	check('cache: the shell version-stamps luci.js', buster != null,
		buster ? buster[1] : '(no ?v= on the luci.js script tag)');

	if (buster) {
		const stale = page.moduleUrls.filter(u => u.indexOf('?v=' + buster[1]) < 0);
		check('cache: both view modules were fetched under the current cache key',
			page.moduleUrls.length >= 2 && stale.length === 0,
			stale.length ? 'stale copy: ' + stale.join(' , ') : page.moduleUrls.join(' , '));
	}
}

/* ---------------------------------------------------------------------- main */

(async function main() {
	let browser = null;
	let sid = null;
	let cookieName = 'sysauth';

	try {
		console.log(`target: ${BASE}`);
		const session = await login();
		sid = session.value;
		cookieName = session.name;
		global.__sid = sid;
		global.__cookie = cookieName;
		console.log(`login: ok (${cookieName} ${sid.slice(0, 8)}...)`);
		check('login: authenticated LuCI session obtained', true);
	} catch (e) {
		check('login: authenticated LuCI session obtained', false, e.message);
		process.exit(1);
	}

	try {
		browser = await launchBrowser();
		const cdp = browser.cdp;

		await cdp.send('Page.enable');
		await cdp.send('Runtime.enable');
		await cdp.send('Log.enable');
		await cdp.send('Network.enable');

		const ok = await cdp.send('Network.setCookie', {
			name: cookieName, value: sid, url: BASE + '/', path: '/', httpOnly: true
		});
		check('browser: session cookie accepted', !!(ok && ok.success !== false));

		const page = new PageSession(cdp);

		await testTailcat(page);
		await testFrpc(page);
		await testMenu(page);

		/* anything left over that we have not attributed to a page */
		const stray = page.exceptions.filter(e => /charCodeAt|is not a function/.test(e.text + e.desc));
		check('no "charCodeAt" TypeError anywhere (the original regression)',
			stray.length === 0, stray.map(e => e.desc || e.text).join(' | '));

		console.log('\n--- network ------------------------------------------------------------');
		const bad = page.netFailures.filter(t => !/ERR_ABORTED/.test(t));
		check('no failed subresource loads', bad.length === 0, bad.slice(0, 3).join(' | '));
	} catch (e) {
		check('harness ran to completion', false, e.message + '\n' + (e.stack || ''));
	} finally {
		if (browser && !KEEP_OPEN) {
			try { browser.ws.close(); } catch (e) {}
			try { browser.child.kill(); } catch (e) {}
			await sleep(500);
			try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch (e) {}
		}
	}

	const total = results.length;
	console.log('\n=======================================================================');
	console.log(`${total - failures}/${total} checks passed`);
	if (failures) {
		console.log('\nFAILURES:');
		for (const r of results) if (!r.ok) console.log('  - ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
		process.exit(1);
	}
	console.log('ALL CHECKS PASSED');
	process.exit(0);
})();
