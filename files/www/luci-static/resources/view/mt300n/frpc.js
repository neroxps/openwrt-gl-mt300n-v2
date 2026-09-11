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
			runCtl([ 'frpc', 'status' ])
		]);
	},

	render: function (data) {
		var st = parseKV(data[1].stdout);

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

		var formNode = m.render();

		/* --------------------------------------------------------- actions */
		var actions = E('div', { 'class': 'cbi-section' }, [
			E('h3', [ _('Actions') ]),
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, function () {
					return runCtl([ 'frpc', 'restart' ]).then(function () {
						ui.addNotification(null, E('p', [ _('frpc restarted') ]));
						window.setTimeout(function () { location.reload(); }, 2500);
					});
				})
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

		return E([ statusBox, formNode, actions ]);
	},

	handleSaveApply: function (ev, mode) {
		return this.super('handleSaveApply', [ ev, mode ]).then(function () {
			return runCtl([ 'frpc', 'restart' ]);
		}).then(function () {
			ui.addNotification(null, E('p', [ _('Configuration applied and frpc restarted') ]));
			window.setTimeout(function () { location.reload(); }, 4000);
		}).catch(function (e) {
			ui.addNotification(null, E('p', [ _('Saved, but restarting failed: ') + (e.message || e) ]));
		});
	}
});
