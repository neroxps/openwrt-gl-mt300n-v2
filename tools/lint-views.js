#!/usr/bin/env node
'use strict';

/*
 * Static guards for the firmware file tree.
 *
 * These run in CI before the image is built. They exist because every one of
 * them encodes a bug that actually shipped once:
 *
 *  1. LuCI 25.x form.Map.render() returns a *Promise*, not a DOM node. Both
 *     custom views once did `var formNode = m.render();` and then handed that
 *     Promise to E([...]), which fell through every branch of dom.create()
 *     into html.charCodeAt() and threw "TypeError: html.charCodeAt is not a
 *     function" - both pages blank. It is not visible to `node --check` or to
 *     a curl of the page, so it needs its own guard. (tools/webtest.js in this
 *     repository is the end-to-end half of that guard and drives a real
 *     browser against a running router.)
 *
 *  2. In LuCI menu.d, depends.acl must be an ARRAY. The object form parses but
 *     breaks dispatcher.uc, which answers HTTP 500 for the entire web UI.
 *
 *  3. The repository is edited from Windows as well as Linux. A CRLF check-out
 *     makes device shell scripts fail with "not found" and corrupts
 *     authorized_keys, so text files must stay LF.
 *
 * Usage: node tools/lint-views.js      (exit 0 = clean, 1 = problems)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TREE = path.join(ROOT, 'files');

const problems = [];
const notes = [];

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

function walk(dir, out) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(p, out);
		else if (entry.isFile()) out.push(p);
	}
	return out;
}

const allFiles = fs.existsSync(TREE) ? walk(TREE, []) : [];

/* ------------------------------------------------ 1. LuCI render() misuse -- */

/*
 * Anything that reaches an E() call as a .render() result, or that stores one
 * in a variable, is passing an unresolved Promise where a node belongs.
 */
function findMatchingParen(text, openIdx) {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		if (c === '(') depth++;
		else if (c === ')') {
			depth--;
			if (depth === 0) return i;
		} else if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			i++;
			while (i < text.length && text[i] !== quote) {
				if (text[i] === '\\') i++;
				i++;
			}
		}
	}
	return -1;
}

function lineOf(text, index) {
	return text.slice(0, index).split('\n').length;
}

const viewFiles = allFiles.filter(f =>
	f.includes(`${path.sep}luci-static${path.sep}resources${path.sep}view${path.sep}`) &&
	f.endsWith('.js'));

for (const f of viewFiles) {
	const src = fs.readFileSync(f, 'utf8');

	/* E(... .render() ...) */
	for (let idx = src.indexOf('E('); idx !== -1; idx = src.indexOf('E(', idx + 1)) {
		const end = findMatchingParen(src, idx + 1);
		if (end < 0) continue;
		const args = src.slice(idx + 2, end);
		const m = /\.render\s*\(\s*\)/.exec(args);
		if (m) {
			problems.push(`${rel(f)}:${lineOf(src, idx + 2 + m.index)}  E() is given a ` +
				`render() result - in LuCI 25.x that is a Promise, not a node ` +
				`(throws "html.charCodeAt is not a function"). Resolve it first, ` +
				`e.g. return m.render().then(function (node) { return E([...]); });`);
		}
	}

	/* var x = something.render(); */
	const re = /^([ \t]*)(?:var|let|const)?[ \t]*([A-Za-z_$][\w$]*)[ \t]*=[ \t]*([\w$.\[\]]+)\.render[ \t]*\([ \t]*\)[ \t]*;/gm;
	let m;
	while ((m = re.exec(src)) !== null) {
		problems.push(`${rel(f)}:${lineOf(src, m.index)}  "${m[2]} = ${m[3]}.render()" stores a ` +
			`Promise - LuCI's render() is asynchronous. Chain it instead.`);
	}
}

/* --------------------------------------------- 2. menu.d depends.acl array -- */

const menuDir = path.join(TREE, 'usr', 'share', 'luci', 'menu.d');
if (fs.existsSync(menuDir)) {
	for (const f of fs.readdirSync(menuDir)) {
		if (!f.endsWith('.json')) continue;
		const p = path.join(menuDir, f);
		let data;
		try {
			data = JSON.parse(fs.readFileSync(p, 'utf8'));
		} catch (e) {
			problems.push(`${rel(p)}  invalid JSON: ${e.message}`);
			continue;
		}
		for (const [key, entry] of Object.entries(data)) {
			const acl = entry && entry.depends && entry.depends.acl;
			if (acl != null && !Array.isArray(acl)) {
				problems.push(`${rel(p)}  "${key}.depends.acl" must be an ARRAY ` +
					`(got ${Array.isArray(acl) ? 'array' : typeof acl}) - the object form ` +
					`makes dispatcher.uc answer HTTP 500 for the whole web UI.`);
			}
		}
		notes.push(`menu.d ${f}: ${Object.keys(data).length} entries, depends.acl form OK`);
	}
}

/* ------------------------------------------------------------- 3. line ends -- */

const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|bin|gz|zst|tar|woff2?|ttf)$/i;
let crlf = 0;
for (const f of allFiles) {
	if (BINARY.test(f)) continue;
	const buf = fs.readFileSync(f);
	if (buf.includes(0x0d))
		{ problems.push(`${rel(f)}  contains CR bytes - this file is copied to the device ` +
			`and must be LF only.`); crlf++; }
}

/* ------------------------------------------------------------------ report -- */

for (const n of notes) console.log(`  ok  ${n}`);
console.log(`scanned ${viewFiles.length} LuCI view script(s), ${allFiles.length} file(s) in files/`);

if (problems.length) {
	console.log(`\n${problems.length} problem(s):\n`);
	for (const p of problems) console.log('  FAIL  ' + p);
	process.exit(1);
}

console.log('\nstatic checks passed');
