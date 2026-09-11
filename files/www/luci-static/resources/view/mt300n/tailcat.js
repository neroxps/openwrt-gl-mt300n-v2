'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require rpc';

/*
 * tailcat configuration - "netcat over Tailscale's data plane".
 *
 * The page is built around what is actually useful for remote operations:
 * the router runs a tailcat server that exposes its own SSH and web UI, so it
 * can be reached from anywhere without opening a single inbound port. The
 * status card shows the stable tailcat address, and there is a one-click
 * end-to-end tunnel test.
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

function yesno(v) {
	return (v === '1') ? E('span', { 'style': 'color:#3c6' }, [ '\u2714 ' + _('yes') ])
	                   : E('span', { 'style': 'color:#c33' }, [ '\u2716 ' + _('no') ]);
}

function kvRow(label, value) {
	return [ label, (value === '' || value == null) ? E('em', [ _('none') ]) : value ];
}

return view.extend({

	load: function () {
		return Promise.all([
			uci.load('tailcat'),
			runCtl([ 'tailcat', 'status' ])
		]);
	},

	render: function (data) {
		var st = parseKV(data[1].stdout);
		var addr = st.address || '';
		var self = this;

		/* ---------------------------------------------------------- status */
		var addrInput = E('input', {
			'type': 'text',
			'readonly': 'readonly',
			'value': addr,
			'style': 'width:100%;font-family:monospace;font-size:11px',
			'placeholder': _('not generated yet - press "Restart" or "New key"')
		});

		var statusBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', [ _('Status') ]),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'width': '22%' }, [ _('Service') ]),
					E('td', { 'class': 'td left' }, [
						st.running === '1' ? E('span', { 'class': 'ifacebadge' }, [ _('running') ])
						                   : E('em', [ _('stopped') ]),
						st.pid ? ' (pid ' + st.pid + ')' : '',
						st.rss_kb ? ' \u00b7 ' + Math.round(st.rss_kb / 1024) + ' MB RAM' : ''
					])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('Installed') ]),
					E('td', { 'class': 'td left' }, [ yesno(st.installed) ])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('Mode') ]),
					E('td', { 'class': 'td left' }, [ st.role === 'forward' ? _('client (forward)') : _('server (serve)') ])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('Exposing') ]),
					E('td', { 'class': 'td left' }, [ st.preset || '', st.custom_ports ? ' (' + st.custom_ports + ')' : '' ])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('DERP region') ]),
					E('td', { 'class': 'td left' }, [ st.region || 'auto' ])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ _('Saved key') ]),
					E('td', { 'class': 'td left' }, [ E('code', [ st.key_name || 'default' ]) ])
				])
			]),
			E('h4', [ _('Tailcat address') ]),
			E('p', { 'class': 'cbi-section-descr' }, [
				_('This is the address a client passes to tailcat. It stays the same across reboots because it is derived from the saved key. Treat it as a secret: whoever has it can reach what you expose here.')
			]),
			addrInput,
			E('div', { 'style': 'margin-top:.5em' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.createHandlerFn(this, function () {
						try {
							addrInput.select();
							document.execCommand('copy');
							ui.addNotification(null, E('p', [ _('Address copied to the clipboard') ]));
						} catch (e) {
							ui.addNotification(null, E('p', [ _('Press Ctrl+C to copy the selected text') ]));
						}
					})
				}, [ _('Copy address') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function () {
						var btn = this;
						ui.showModal(_('Testing tunnel'), [ E('p', { 'class': 'spinning' }, [ _('Connecting to our own address through the DERP relay - this takes up to 30 seconds...') ]) ]);
						return runCtl([ 'tailcat', 'ping' ]).then(function (r) {
							ui.hideModal();
							var out = (r.stdout || '') + (r.stderr || '');
							var ok = /pong/i.test(out);
							ui.showModal(_('Tunnel test'), [
								E('p', ok ? { 'class': 'alert-message success' } : { 'class': 'alert-message warning' },
									[ ok ? _('Tunnel works: the relay answered.') : _('No answer from the tunnel yet.') ]),
								E('pre', { 'style': 'white-space:pre-wrap;max-height:12em;overflow:auto' }, [ out || _('(no output)') ]),
								E('div', { 'class': 'right' }, [
									E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Dismiss') ])
								])
							]);
						});
					})
				}, [ _('Test tunnel') ])
			])
		]);

		/* ------------------------------------------------------------ form */
		var m = new form.Map('tailcat', _('tailcat'),
			_('Uses Tailscale\'s WireGuard data plane and DERP relays without a Tailscale account. ' +
			  'The router runs entirely in userspace: no account, no kernel TUN device.'));

		var s = m.section(form.NamedSection, 'main', 'tailcat', _('Settings'));
		s.anonymous = true;

		var o = s.option(form.Flag, 'enabled', _('Enable'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'role', _('Mode'));
		o.value('serve', _('Server - offer this router\'s services to clients'));
		o.value('forward', _('Client - forward another tailcat server\'s ports here'));
		o.default = 'serve';

		o = s.option(form.ListValue, 'preset', _('What to expose'));
		o.value('ssh_web', _('SSH + web UI  (22, 80, 443) - recommended'));
		o.value('ssh', _('SSH only  (22)'));
		o.value('web', _('Web UI only  (80, 443)'));
		o.value('all', _('Every port'));
		o.value('tailcat_ssh', _('tailcat SSH server (public keys required)'));
		o.value('no_auth_ssh', _('Auth-free SSH - the address is the password'));
		o.value('files', _('File server (SFTP / scp)'));
		o.value('exit_node', _('Exit node - give clients access to this LAN'));
		o.value('custom', _('Custom port list below'));
		o.default = 'ssh_web';
		o.depends('role', 'serve');

		o = s.option(form.Value, 'custom_ports', _('Custom ports'),
			_('Port numbers, ranges and service names, comma separated, e.g. 22,80,443 or 8000-8999,ssh'));
		o.depends('preset', 'custom');

		o = s.option(form.Value, 'key_name', _('Saved key name'),
			_('A saved key keeps the tailcat address stable across reboots. Changing this name generates a different address.'));
		o.default = 'default';

		o = s.option(form.ListValue, 'region', _('DERP region'),
			_('Which relay to bootstrap through. Pick the nearest for the lowest latency. Changing it regenerates the key, which changes the address.'));
		o.value('auto', _('auto - lowest latency at startup'));
		o.value('tok', _('tok - Tokyo'));
		o.value('fra', _('fra - Frankfurt'));
		o.value('sfo', _('sfo - San Francisco'));
		o.value('nyc', _('nyc - New York'));
		o.default = 'auto';

		o = s.option(form.Value, 'allow', _('Allowed client keys'),
			_('Comma-separated client public keys allowed to connect (nodekey:...). ' +
			  'Get one on the client with "tailcat genkey --client --key=client-default". ' +
			  'Empty means any client that knows the address. Use "none" to allow nobody.'));
		o.rmempty = true;

		o = s.option(form.TextValue, 'ssh_authorized_keys', _('SSH authorized keys'),
			_('For the "tailcat SSH server" preset: comma-separated authorized_keys file paths, ' +
			  'literal public key lines, or user@github to fetch https://github.com/user.keys'));
		o.rows = 4;
		o.depends('preset', 'tailcat_ssh');

		o = s.option(form.Value, 'files_share', _('Shared directory'),
			_('For the file server preset. A directory with an optional :ro (default), :rw, :wo or :wo+ suffix.'));
		o.depends('preset', 'files');

		o = s.option(form.Value, 'forward_addr', _('Remote tailcat address'),
			_('Client mode: the tailcat address (or DNS name with a "tailcat=" TXT record) to connect to.'));
		o.depends('role', 'forward');

		o = s.option(form.Value, 'forward_map', _('Port mapping'),
			_('Client mode: space-separated mappings such as "18022:22 18080:80". ' +
			  'A single number uses the same local and remote port.'));
		o.depends('role', 'forward');

		o = s.option(form.ListValue, 'bind', _('Bind forwarded ports to'),
			_('127.0.0.1 keeps the forwarded ports private to the router; 0.0.0.0 exposes them to the LAN.'));
		o.value('127.0.0.1', _('127.0.0.1 (router only)'));
		o.value('0.0.0.0', _('0.0.0.0 (whole LAN)'));
		o.default = '127.0.0.1';
		o.depends('role', 'forward');

		o = s.option(form.Flag, 'fixed_region', _('Bake the region into the key'),
			_('Only needed if you publish the address in DNS. Changing it regenerates the key.'));
		o.default = '0';

		o = s.option(form.Value, 'derpmap_url', _('DERP map URL'),
			_('Leave empty to use the copy shipped with this firmware (served locally at ' +
			  'http://127.0.0.1/derpmap.json, with the project mirror as fallback). ' +
			  'tailcat\'s own default, https://tailcat.dev/derpmap.json, is not reachable from every network.'));
		o.rmempty = true;

		o = s.option(form.Flag, 'verbose', _('Verbose logging'));
		o.default = '0';

		o = s.option(form.Value, 'extra_args', _('Extra arguments'),
			_('Appended verbatim to the tailcat command line.'));
		o.rmempty = true;

		var formNode = m.render();

		/* --------------------------------------------------------- actions */
		var actions = E('div', { 'class': 'cbi-section' }, [
			E('h3', [ _('Actions') ]),
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, function () {
					return runCtl([ 'tailcat', 'restart' ]).then(function () {
						ui.addNotification(null, E('p', [ _('tailcat restarted') ]));
						window.setTimeout(function () { location.reload(); }, 2500);
					});
				})
			}, [ _('Restart tailcat') ]),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(this, function () {
					return runCtl([ 'tailcat', 'stop' ]).then(function () {
						ui.addNotification(null, E('p', [ _('tailcat stopped') ]));
						window.setTimeout(function () { location.reload(); }, 1500);
					});
				})
			}, [ _('Stop') ]),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-action important',
				'click': ui.createHandlerFn(this, function () {
					var self = this;
					return ui.showModal(_('Generate a new key?'), [
						E('p', [ _('This creates a brand new key and therefore a NEW tailcat address. ' +
						           'Every client you already shared the old address with loses access.') ]),
						E('div', { 'class': 'right' }, [
							E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
							' ',
							E('button', {
								'class': 'btn cbi-button-negative important',
								'click': ui.createHandlerFn(this, function () {
									ui.hideModal();
									ui.showModal(_('Generating key'), [ E('p', { 'class': 'spinning' }, [ _('Please wait...') ]) ]);
									return runCtl([ 'tailcat', 'genkey' ]).then(function (r) {
										ui.hideModal();
										ui.showModal(_('New key'), [
											E('pre', { 'style': 'white-space:pre-wrap;max-height:12em;overflow:auto' }, [ (r.stdout || '') + (r.stderr || '') ]),
											E('div', { 'class': 'right' }, [ E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Dismiss') ]) ])
										]);
										window.setTimeout(function () { location.reload(); }, 4000);
									});
								})
							}, [ _('Generate new key') ])
						])
					]);
				})
			}, [ _('New key') ]),
			' ',
			E('button', {
				'class': 'btn cbi-button',
				'click': ui.createHandlerFn(this, function () {
					return runCtl([ 'tailcat', 'log', '60' ]).then(function (r) {
						ui.showModal(_('tailcat log'), [
							E('pre', { 'style': 'white-space:pre-wrap;max-height:24em;overflow:auto;font-size:11px' },
								[ r.stdout || _('(empty)') ]),
							E('div', { 'class': 'right' }, [ E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Dismiss') ]) ])
						]);
					});
				})
			}, [ _('Show log') ])
		]);

		return E([ statusBox, actions, formNode ]);
	},

	/* Saving applies the UCI changes and then restarts the service, so the new
	 * configuration is live (and comes back automatically after a reboot). */
	handleSaveApply: function (ev, mode) {
		return this.super('handleSaveApply', [ ev, mode ]).then(function () {
			return runCtl([ 'tailcat', 'restart' ]);
		}).then(function () {
			ui.addNotification(null, E('p', [ _('Configuration applied and tailcat restarted') ]));
			window.setTimeout(function () { location.reload(); }, 4000);
		}).catch(function (e) {
			ui.addNotification(null, E('p', [ _('Saved, but restarting failed: ') + (e.message || e) ]));
		});
	}
});
