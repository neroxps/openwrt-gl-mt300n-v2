'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';

/*
 * frpc configuration.
 *
 * The whole frpc.toml is edited directly in a text area - no per-option forms
 * to click through. The text is stored in UCI (so it survives a reboot) and is
 * written to /tmp/opt/etc/frpc.toml when the service starts.
 */

var CTL = '/usr/bin/mt300n-ctl';

/*
 * Normalise command output.
 *
 * This rpcd build returns file.exec stdout/stderr as plain UTF-8 text
 * (verified on the device). Some builds base64-encode it instead, so decode
 * only when the string is unambiguously base64 and the result is printable -
 * plain text always contains a newline or an "=" in the middle, which fails
 * that test, so it is never touched.
 */
function decodeOut(s) {
	if (typeof s !== 'string' || s === '')
		return '';

	if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0) {
		try {
			var bin = atob(s);
			var bytes = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++)
				bytes[i] = bin.charCodeAt(i);
			var txt = new TextDecoder('utf-8').decode(bytes);
			if (/^[\t\n\r\x20-\x7e]*$/.test(txt))
				return txt;
		} catch (e) { /* not base64 after all */ }
	}

	return s;
}

function runCtl(args) {
	return fs.exec(CTL, args).then(function (res) {
		return {
			code: (res && res.code != null) ? res.code : -1,
			stdout: decodeOut(res && res.stdout),
			stderr: decodeOut(res && res.stderr)
		};
	}).catch(function (e) {
		return { code: -1, stdout: '', stderr: e.message || String(e) };
	});
}

function parseKV(text) {
	var out = {};
	(text || '').split('\n').forEach(function (line) {
		var i = line.indexOf('=');
		if (i > 0)
			out[line.substring(0, i)] = line.substring(i + 1);
	});
	return out;
}

function badge(v, onText, offText) {
	return (v === '1')
		? E('span', { 'class': 'ifacebadge' }, [ onText ])
		: E('em', [ offText ]);
}

return view.extend({

	load: function () {
		return Promise.all([
			uci.load('frpc'),
			runCtl([ 'frpc', 'status' ]),
			/* frpc's own verdict on the stored TOML, before anything is
			 * started with it. */
			runCtl([ 'frpc', 'check' ])
		]);
	},

	render: function (data) {
		var st = parseKV(data[1].stdout);
		var ck = parseKV(data[2].stdout);
		var cfgOk = (ck.ok === '1');

		/*
		 * frpc answers a TOML syntax error with the message of its YAML
		 * fallback ("json: cannot unmarshal string into Go value of type
		 * v1.ClientConfig"), which hides the real mistake, so the runner adds
		 * a hint that is shown right below it.
		 */
		function reportBadConfig(c) {
			var body = [
				_('frpc rejected the configuration: '),
				E('code', [ c.error || _('(no message)') ])
			];
			if (c.hint)
				body.push(E('br'), E('em', [ c.hint ]));
			body.push(E('br'), _('It was not started. Fix the TOML below and save again.'));
			ui.addNotification(null, E('p', body), 'error');
		}

		var configCell;
		if (cfgOk) {
			configCell = badge('1', _('valid'), _('invalid'));
		} else if (ck.code === '1' || st.installed !== '1') {
			configCell = E('em', [ _('cannot check - frpc is not installed yet') ]);
		} else {
			var kids = [ E('span', { 'style': 'color:#c00;font-weight:bold' }, [ _('rejected by frpc') ]) ];
			if (ck.error)
				kids.push(E('div', { 'style': 'font-size:11px;color:#c00' }, [ ck.error ]));
			if (ck.hint)
				kids.push(E('div', { 'style': 'font-size:11px;color:#800' }, [ ck.hint ]));
			configCell = E('div', {}, kids);
		}

		/* ---------------------------------------------------------- status */
		var statusBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', [ _('Status') ]),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'width': '22%' }, [ _('Service') ]),
					E('td', { 'class': 'td left' }, [
						badge(st.running, _('running'), _('stopped')),
						st.pid ? ' (pid ' + st.pid + ')' : '',
						st.rss_kb ? ' \u00b7 ' + Math.round(st.rss_kb / 1024) + ' MB RAM' : ''
					])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('Installed') ]),
					E('td', { 'class': 'td left' }, [ badge(st.installed, _('yes'), _('no')) ])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('Enabled') ]),
					E('td', { 'class': 'td left' }, [ badge(st.enabled, _('yes'), _('no')) ])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('serverAddr set') ]),
					E('td', { 'class': 'td left' }, [ badge(st.configured, _('yes'), _('no')) ])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('Configuration') ]),
					E('td', { 'class': 'td left' }, [ configCell ])
				])
			]),
			E('p', { 'class': 'cbi-section-descr' }, [
				_('frpc only starts once serverAddr is filled in below. It is installed into RAM (/tmp/opt) and re-fetched automatically at every boot.')
			])
		]);

		/* ------------------------------------------------------------ form */
		var m = new form.Map('frpc', _('frpc'),
			_('Reverse proxy client. Edit the TOML file below and press "Save & Apply": ' +
			  'the configuration is stored in UCI and frpc is restarted with it.'));

		var s = m.section(form.NamedSection, 'main', 'frpc', _('Configuration'));
		s.anonymous = true;

		var o = s.option(form.Flag, 'enabled', _('Enable'));
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.TextValue, 'config', _('frpc.toml'));
		o.rows = 26;
		o.description = _('The complete frpc configuration file. Written to /tmp/opt/etc/frpc.toml at start.');
		o.cfgvalue = function (section_id) {
			return uci.get('frpc', section_id, 'config') || '';
		};
		o.write = function (section_id, value) {
			uci.set('frpc', section_id, 'config', value);
		};
		o.remove = function (section_id) {
			uci.unset('frpc', section_id, 'config');
		};

		/* --------------------------------------------------------- actions */
		/*
		 * Restart, and report what frpc thinks of the configuration first -
		 * a rejected TOML means the service never comes up, and saying
		 * "restarted" in that case would be a lie.
		 */
		function restartAndReport() {
			return runCtl([ 'frpc', 'check' ]).then(function (r) {
				var c = parseKV(r.stdout);
				return runCtl([ 'frpc', 'restart' ]).then(function () { return c; });
			}).then(function (c) {
				if (c.ok === '1') {
					ui.addNotification(null, E('p', [ _('frpc restarted') ]));
					window.setTimeout(function () { location.reload(); }, 2500);
				} else {
					reportBadConfig(c);
				}
			});
		}

		var actions = E('div', { 'class': 'cbi-section' }, [
			E('h3', [ _('Actions') ]),
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, restartAndReport)
			}, [ _('Restart frpc') ]),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(this, function () {
					return runCtl([ 'frpc', 'stop' ]).then(function () {
						ui.addNotification(null, E('p', [ _('frpc stopped') ]));
						window.setTimeout(function () { location.reload(); }, 1500);
					});
				})
			}, [ _('Stop') ]),
			' ',
			E('button', {
				'class': 'btn cbi-button',
				'click': ui.createHandlerFn(this, function () {
					return runCtl([ 'frpc', 'log', '60' ]).then(function (r) {
						ui.showModal(_('frpc log'), [
							E('pre', { 'style': 'white-space:pre-wrap;max-height:24em;overflow:auto;font-size:11px' },
								[ r.stdout || _('(empty)') ]),
							E('div', { 'class': 'right' }, [ E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Dismiss') ]) ])
						]);
					});
				})
			}, [ _('Show log') ])
		]);

		/*
		 * form.Map.render() returns a Promise that resolves to the form
		 * element - not the element itself. Passing that Promise to E() lands
		 * in dom.create(), where no branch matches (a Promise is an object but
		 * has no nodeType) and it falls through to html.charCodeAt(), which
		 * throws "html.charCodeAt is not a function" and blanks the page. So
		 * the page is assembled once the form has actually been built.
		 */
		return m.render().then(function (formNode) {
			return E([ statusBox, formNode, actions ]);
		});
	},

	handleSaveApply: function (ev, mode) {
		return this.super('handleSaveApply', [ ev, mode ]).then(function () {
			return runCtl([ 'frpc', 'check' ]).then(function (r) {
				var c = parseKV(r.stdout);
				return runCtl([ 'frpc', 'restart' ]).then(function () { return c; });
			});
		}).then(function (c) {
			if (c.ok === '1') {
				ui.addNotification(null, E('p', [ _('Configuration applied and frpc restarted') ]));
				window.setTimeout(function () { location.reload(); }, 4000);
			} else {
				ui.addNotification(null, E('p', [
					_('Configuration saved, but frpc rejected it: '),
					E('code', [ c.error || _('(no message)') ]),
					c.hint ? E('span', [ E('br'), E('em', [ c.hint ]) ]) : ''
				]), 'error');
				window.setTimeout(function () { location.reload(); }, 6000);
			}
		}).catch(function (e) {
			ui.addNotification(null, E('p', [ _('Saved, but restarting failed: ') + (e.message || e) ]));
		});
	}
});
