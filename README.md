# OpenWrt 25.12.5 for the GL.iNet GL-MT300N-V2 (Mango)

Pre-built, reproducible image plus a runtime payload for the
**GL.iNet GL-MT300N-V2** — MediaTek MT7628NN, `ramips/mt76x8`,
128 MB RAM, **16 MB flash**, `mipsel_24kc` (soft-float).

Everything is built by GitHub Actions; nothing is compiled on the device.

## What gets built

| Artifact | Purpose |
| --- | --- |
| `openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin` | flashable image (`sysupgrade`), 6.29 MB |
| `payload-mipsel_24kc.tar.gz` | **default**: `tailcat` + `frpc` |
| `payload-tailscale-mipsel_24kc.tar.gz` | **optional**: `tailscaled` + `tailscale` CLI |

Each payload is published twice — as a release asset and as a plain file on the
`payload` branch. **The device uses the branch copy**, because GitHub's
`/releases/latest/download/` URL answers with a 302 and the OpenWrt
downloaders do not follow redirects; through the proxy the raw branch URL is
always a clean `200`.

## The web UI

Two pages live under **Services** in LuCI.

### Services → tailcat

[tailcat](https://github.com/tailscale/tailcat) is *"netcat over Tailscale's
data plane"* — Tailscale's WireGuard + NAT traversal + DERP relays **without**
the control plane or an account. It runs entirely in userspace, so it needs
neither a Tailscale account nor a kernel TUN device.

The page is built around remote operations:

* **Status card** — running/stopped, PID, RAM, mode, what is exposed, DERP
  region, and the **tailcat address** in a copyable field.
* **One-click end-to-end test** — dials the router's own address through the
  relay and reports whether the tunnel answers.
* **What to expose** (one dropdown):

  | preset | effect |
  | --- | --- |
  | `SSH + web UI` (22, 80, 443) | **default** — reach the router's shell and LuCI from anywhere |
  | `SSH only` (22) | shell only |
  | `Web UI only` (80, 443) | LuCI only |
  | `Every port` | everything |
  | `tailcat SSH server` | tailcat's own SSH server, public keys required |
  | `Auth-free SSH` | the address itself is the password |
  | `File server` | SFTP / scp drop box or share |
  | `Exit node` | give clients access to the whole LAN |
  | `Custom` | your own port list, e.g. `22,8000-8999,ssh` |

* **Client mode** — point the router at another tailcat server and expose that
  server's ports as local ports (`forward`, with a bind-address choice).
* **New key / Restart / Stop / Show log** buttons.
* **Save & Apply** writes UCI and restarts the service, so the change is live
  immediately *and* comes back after a reboot.

The router needs **no inbound port open**: the tunnel is outbound to the relay.

### Services → frpc

A single text area holding the **complete `frpc.toml`** — no per-option forms.
The text is stored in UCI (so it survives a reboot) and written to
`/tmp/opt/etc/frpc.toml` when the service starts. Save & Apply restarts frpc.
It stays idle until `serverAddr` is filled in and enabled.

#### The configuration is verified before frpc is started

`mt300n-frpc-run` writes the TOML to a scratch file and runs **frpc's own
`verify`** on it first. A rejected configuration is logged and the service
simply does not start, instead of procd respawning a client that can never come
up (`Instance frpc::instance1 s in a crash loop 6 crashes`).

This matters because frpc 0.66 answers a TOML syntax error with the message its
YAML fallback produces for the whole file:

```
json: cannot unmarshal string into Go value of type v1.ClientConfig
```

which says nothing about the real mistake. Measured on the device: a file
containing nothing but `hello world` produces that very same line, and so does
a proxy block that lost its `[[proxies]]` header — in TOML the keys after a
`[[proxies]]` header belong to that array's last element, so `name`, `localIP`,
`localPort` and `remotePort` then collide with the ones already defined there,
and the file no longer parses. So when that message appears, the runner adds
what it hides.

| Where | What |
| --- | --- |
| `mt300n-ctl frpc check` | `ok=1`, or `ok=0` + `code=` + `error=` + `hint=` |
| `mt300n-ctl frpc status` | includes `ok=`/`error=` for the stored TOML |
| LuCI → Services → frpc | a **Configuration** row: *valid*, *rejected by frpc* with the message and the hint, or *cannot check* while the payload is not installed |
| Save & Apply | reports **"frpc rejected it"** with the message instead of claiming the service restarted |

Every proxy needs its own `[[proxies]]` line; `remotePort = 0` is legal and
means "let the server choose", in which case the assigned port changes between
connections (`frpc status -c /tmp/opt/etc/frpc.toml` prints what it got).

#### Which frpc the device runs

The payload carries the **frp v3 client** — `neroxps/frp-v3`, a private fork of
frp v0.71.0 whose only two changes are the websocket path (`/~!frp` →
`/api/v1/stream`) and the wire-protocol magic (the literal `FRP…` header → nine
zero bytes). Upstream `frpc` over `tcp + tls` still works against it; `wss` does
not, because that path must match on both ends.

| | |
| --- | --- |
| Where it comes from | CI clones the private fork at `FRP_V3_VERSION` and cross-compiles it |
| Secret it needs | `FRP_V3_TOKEN` — a token with **read** access to `neroxps/frp-v3` |
| Without the secret | the job warns and falls back to upstream `FRP_VERSION`, and the payload says so |
| How to see which one arrived | `mt300n-ctl frpc status` → `version=0.71.0-v3`; LuCI shows it next to *Installed*; `/tmp/opt/INSTALLED.txt` records it on the device; `MANIFEST.txt` and `FRPC_FLAVOUR` on the payload branch record it per build |

The payload branch is **force-replaced** on every CI run, so nothing placed there
by hand survives; the client has to come from the workflow.

Runtime configuration notes for this client:

* `transport.wireProtocol = "v2"` is what makes the patched magic matter. It is
  set on the device and verified: the v2 login succeeds against the v3 `frps`,
  while an upstream client cannot complete that handshake.
* `transport.tls.disableCustomTLSFirstByte = true` avoids the non-standard
  `0x17` first byte; `transport.tls.serverName` keeps a real SNI;
  `transport.tls.trustedCaFile` pins the server CA (needs the `ca.crt` on the
  device — not shipped).
* `wss` needs the reverse proxy on **443** and only works where that port is
  reachable. Measured from this uplink: 443 times out for both `tcp` and `wss`
  while `5501` logs in, so the device uses `tcp + tls` on 5501.
* From frp v0.68 on, proxy names are **no longer prefixed with `user`**: the
  server sees `mt300n-ssh`, not `GL-MT300N-V2.mt300n-ssh`. Scripts that match
  on the prefixed name have to be updated, or the prefix has to go into `name`.

## Environment

`/etc/profile.d/20-mt300n-path.sh` puts `/tmp/opt/bin` on `PATH`, so after the
payload is fetched `tailcat`, `tailscale` and `frpc` are ordinary commands in
every login shell.

## Boot behaviour

1. The WAN port (`eth0.2`) requests a DHCP lease.
2. The **middle LED** (`green:wan`) fast-blinks while there is no usable internet.
3. Once the WAN can reach the internet, `mt300n-payload` runs `mt300n-install`,
   which pulls `payload/install.sh` and `payload/packages.txt` from this
   repository through the `ghfast.top` proxy and installs the payload into
   `/tmp/opt`. The LED blinks faster during the install.
4. The services start, and once the tools are loaded the LED goes **solid**.

Observed on the device:

```
glstatus: state=offline      # no internet    -> fast blink (timer 125/125)
glstatus: state=online       # internet up     -> solid
mt300n-autorun: internet is up after 5s
glstatus: state=installing   # downloading     -> faster blink (timer 80/80)
tailcat: starting: /tmp/opt/bin/tailcat ... serve 22 80 443
glstatus: state=ready        # tools loaded    -> solid
```

### LED map

From the upstream device tree
`target/linux/ramips/dts/mt7628an_glinet_gl-mt300n-v2.dts` (OpenWrt 25.12.5):

| sysfs name | GPIO | active | physical position |
| --- | --- | --- | --- |
| `green:power` | 42 | low | top (power) |
| `green:wan` | 43 | low | **middle — used as the status LED** |
| `red:wlan` | 44 | low | wifi |

| state | middle LED | trigger |
| --- | --- | --- |
| `offline` | fast blink, 4 Hz | `timer` 125 / 125 ms |
| `installing` | fast blink, 6 Hz | `timer` 80 / 80 ms |
| `error` | very fast blink, 8 Hz | `timer` 60 / 60 ms |
| `online` / `ready` | **solid** | trigger `none`, brightness 1 |

State priority is `error > installing > ready > online > offline`. The link
probe is debounced (3 consecutive failures) so a single lost packet does not
make the LED flicker.

## Hardware mode switch

Next to the reset button there is a slide switch. It is a **3-way toggle whose
right-hand third is blocked by a plastic post from the factory**, so only two
positions are reachable, and it selects the router's mode:

| switch | /tmp/mt300n-switch | mode | wifi | WAN | DHCP |
| --- | --- | --- | --- | --- | --- |
| away from reset | both pins low (centre) | **router** | `NeroRoute` | dhcp client | for LAN **and** wifi, from OpenWrt's dnsmasq |
| toward reset | one pin high | **ap** | `NeroAP` | unused | only for wifi, only when the bridge has no upstream DHCP server |

Wifi key is `Aa89981166` in both modes. `mt300n-moded` reads the switch every two
seconds (two identical samples required) and applies the mode, so it works at
boot and while running. `mt300n-ctl mode` shows what it read; `mt300n-ctl mode
set <router|ap>` pins a mode by hand and `mt300n-ctl mode auto` hands control
back to the switch.

### The hardware

The switch is wired to the two spare keys of this board, which the device tree
already declares and OpenWrt's button-hotplug driver owns:

| dt node | dt gpio | gpiochip line | physical |
| --- | --- | --- | --- |
| `BTN_0` | `&gpio 0` | 512 | switch, "left" |
| `BTN_1` | `&gpio 3` | 515 | switch, "right" (unreachable unless the plastic post is removed) |
| `reset` | `&gpio 38` | 550 | reset button |

The switch pulls its selected pin high and leaves the other low, so the centre
position reads `lo` on both and an extreme reads `hi` on exactly one. Measured
on the device with the switch away from reset: `lo`/`lo`, i.e. that position is
the centre. Because the centre is "both low", the rule in
`/usr/bin/mt300n-mode-switch` is simply *either pin high means toward reset*, so
it does not depend on knowing which pin the reachable extreme drives.

The pins stay owned by the button driver - that driver also owns the reset
button, and unbinding it would cost us factory-reset-by-button - so the levels
are read from the gpiolib debugfs listing, which reports the state of every
requested line and needs no extra packages.

Note the device tree declares both pins `GPIO_ACTIVE_LOW` although the hardware
drives them high, so the button *events* for `BTN_0`/`BTN_1` are inverted. That
is harmless: this firmware reads the raw line levels instead, and nothing acts on
those two keys.

### AP mode, and keeping DHCP off the LAN port

In AP mode the LAN port and the wifi are **one bridge** (`br-lan` = `eth0.1` +
`wlan0`), which is what the mode is for: plug the LAN port into whatever is
there and the wireless clients are on that same segment. Two things then have to
be right, and both are enforced rather than assumed:

* **The wired port never gets DHCP from this router.** Both the wired and the
  wireless client arrive on `br-lan`, so nothing in the `inet` family can tell
  them apart - but the `bridge` family still sees the individual ports. AP mode
  therefore installs

  ```
  table bridge mt300n
    chain input  iifname "eth0.1" udp dport 67 counter drop
  ```

  and this is the only reason `kmod-nft-bridge` is in the image. A wireless
  client arrives on the `wlan0` port and is unaffected.

* **DHCP is only served when the bridge carries no upstream DHCP server.** With
  an upstream present this router stays silent and takes its own address from
  it, so it remains reachable inside that network; with none it serves the
  wireless side from a separate dnsmasq instance (`/var/etc/mt300n-ap-dhcp.conf`,
  DHCP only, `port=0`) while OpenWrt's dnsmasq keeps doing DNS. OpenWrt's own
  instance cannot be scoped to a bridge port, hence the second one.

  Detection is active rather than passive - it does not depend on somebody else
  asking for a lease. The router sends its own DISCOVER carrying the vendor
  class `MTPROBE`, and the DHCP server it runs ignores that class, so a reply
  can only have come from somebody else. `mt300n-apmode` requires two consecutive
  successful probes before switching, and three consecutive missed ones before
  switching back.

AP mode therefore looks like this:

| bridge has an upstream DHCP server | br-lan address | our DHCP |
| --- | --- | --- |
| yes | dhcp client (stays reachable in that network) | off |
| no | `192.168.1.1/24` | on, wireless clients only |

Caveats worth knowing:

* In AP mode the **WAN port is not used** - the LAN port is the uplink. It is
  set to `proto none` so it cannot add a stray default route.
* A **wired** client gets no address from this router in AP mode, by design. If
  the wired side has no DHCP server either, give that device a static address in
  `192.168.1.0/24` to reach the router.
* The middle LED keeps its existing meaning (blinking = no internet), so in AP
  mode with no uplink it blinks.

### Testing it

```sh
mt300n-ctl mode                      # what the switch reads, and what was applied
mt300n-ctl mode selftest             # proves the DHCP scoping for the current mode
```

`mt300n-selftest` builds throwaway `veth` bridge ports - one standing in for the
LAN port with the production drop rule attached, one for the wireless port -
and asks both for a lease. In AP mode the dropped port must get nothing and the
other must get a lease; in router mode the bridge must be served as before. That
is the only way to exercise the rule from inside the router, because traffic the
router generates itself has no bridge port. On hardware it reports:

```
iifname "eth0.1" udp dport 67 counter packets 3 bytes 1053 drop
PASS: DHCP is served on a bridge port that is not the LAN port, and never on one that is
```

where that `eth0.1` counter counts real requests from the wired side being
dropped.

## Why the payload is not flashed

`tailcat` + `frpc` are Go programs. Stripped they are still ~37 MB, which does
not fit in the ~9.3 MB of free overlay on a 16 MB SPI flash, so they are
installed into **tmpfs (`/tmp/opt`)** and re-fetched after each boot. Their
*configuration* lives in flash (`/etc/config/*`), and tailcat's saved key lives
at `/etc/tailcat/keys/` — which is what makes the address stable.

Size engineering (official binaries carry full DWARF debug info and are far too
large — `tailscaled` 38.9 MB plus a separate 32.2 MB CLI):

| binary | upstream | this build |
| --- | --- | --- |
| `tailcat` | n/a (no mipsel release) | **18.6 MB** |
| `frpc` | 16.6 MB | **17.1 MB** |
| `tailscaled` (+CLI) | 71 MB | 29.0 MB |
| **default total** | — | **~37 MB** |

tailcat does not publish mipsel binaries, so it is cross-compiled here with the
exact tag list the project ships in `build-tags.txt`.

### Memory

There is **no swap on this target**: the ramips/mt76x8 kernel is built without
`CONFIG_SWAP`, so `/proc/swaps` does not exist and `zram` cannot help. The
payload permanently occupies ~35 MB of the ~120 MB usable RAM; `tailcat` runs
at ~19-22 MB RSS and `frpc` ~13 MB.

## Operations notes (things that bit us)

* **Never reinstall while the services run.** tmpfs keeps a *deleted* file
  alive while a process still holds it open, so replacing the binaries in place
  leaks their full size — invisible to `du` and unreclaimable by `rm`. The
  installer therefore stops tailcat/frpc first.
* **Cache-buster on every fetch.** The GitHub proxies cache raw files
  aggressively, so a freshly pushed `install.sh` would otherwise still be
  served from cache. All fetches carry a unique query string.
* **Integrity is verified by running the binary.** A truncated download leaves
  a file that exists and is executable but segfaults, so the readiness check
  runs `tailcat version` / `frpc --version` instead of trusting a flag.
* **The DERP region is baked into the key** (`fixed_region 1`). With an auto
  region tailcat re-probes at each start and the address can drift by a
  character, silently breaking every client holding the old one.
* **No `dropbear` interface restriction.** Binding dropbear to the `lan`
  interface makes `127.0.0.1`/`::1` dead, which breaks every tunnel that
  proxies to localhost (including `tailcat serve 22`). Inbound access is
  controlled by the firewall zone, not the bind address.
* **`tailcat.dev` is not reachable everywhere**, so a copy of its DERP map
  ships in the image (`/www/derpmap.json`, served at
  `http://127.0.0.1/derpmap.json`) with the project mirror as fallback.
* **The installer needs ~50 MB free** because the downloaded archive (~12 MB)
  and the extracted payload (~37 MB) must coexist.
* **A browser can keep serving a stale copy of a page you just fixed.** LuCI
  versions every JS module URL as `?v=<luci revision>-<mtime of
  /lib/apk/db/installed>` — `runtime.uc` computes that mtime, `header.ut` puts
  it on the `luci.js` script tag, and `luci.js` reads it back out of its own tag
  and reuses it for every `L.require()`. Image builds are reproducible, so the
  key is a constant: replacing `view/mt300n/*.js` leaves its URL unchanged and
  the browser may keep the old file, so the device is fixed while the page still
  throws. `/etc/uci-defaults/97-luci-cache-buster` moves that mtime once per
  flash, and `tools/webtest.js` asserts that the modules a browser fetches carry
  the key the router advertises.
* **in `menu.d`, `depends.acl` must be the array form** (`["name"]`). The
  object form makes the whole LuCI UI return HTTP 500.
* **`form.Map.render()` is asynchronous** — in LuCI 25.x it returns a Promise
  that resolves to the form element, not the element itself. Storing it
  (`var formNode = m.render()`) and then handing it to `E([...])` reaches
  `dom.create()`, matches none of its branches (a Promise is an object but has
  no `nodeType`) and falls through to `html.charCodeAt(0)`, which throws
  `TypeError: html.charCodeAt is not a function` and leaves the page blank.
  Both custom pages shipped like that once; `tools/lint-views.js` now fails the
  build on the pattern.

## Staying in control after a flash

* LAN is always `192.168.1.1/24` on `br-lan`.
* `dropbear` keeps password auth on (a freshly flashed OpenWrt has an empty
  root password) and listens on all interfaces, so both the LAN and a tunnel
  can reach it.
* CI bakes the `SSH_AUTHORIZED_KEY` repository secret into **both**
  `/etc/dropbear/authorized_keys` and `/root/.ssh/authorized_keys`, so key
  login works even with a reset configuration.
* U-Boot lives in a read-only partition `sysupgrade` never touches and the
  device exposes U-Boot web/TFTP recovery at `192.168.1.1` (hold reset while
  powering on). The read-only `factory` partition holds the MAC address and
  wifi calibration data, so a failed flash is recoverable.

## Using the device

```sh
/usr/sbin/mt300n-install          # re-run the installer (also runs at boot)
/usr/bin/mt300n-ctl status        # everything at a glance
/usr/bin/mt300n-ctl tailcat ping  # end-to-end tunnel self-test
/usr/bin/mt300n-ctl tailcat genkey
/usr/bin/mt300n-ctl tailcat log 60
/usr/bin/glstate offline          # force a LED state, for testing

tailcat version
tailcat genkey --list
frpc --version
```

### Temporary Wi-Fi uplink (testing aid)

The WAN port needs a cable. To give the router internet without one:

```sh
/usr/sbin/mt300n-wifi-uplink on  "SSID" "password"
/usr/sbin/mt300n-wifi-uplink off      # remove every trace of it
```

`on` creates a station interface *next to* the existing AP (the MT7628 radio
supports concurrent VAPs), pins its name with `ifname` (without that netifd
reports `NO_DEVICE` and the station associates but never gets a lease), and
adds it to the `wan` firewall zone so it provides the default route exactly
like the Ethernet WAN. `off` restores the wired-WAN-only configuration.

## Testing

Two layers, both runnable from a checkout. The first is a CI gate; the second
needs the router reachable on the LAN.

```sh
node tools/lint-views.js                  # static guards, no device needed
node tools/webtest.js                     # whole UI, against 192.168.1.1
node tools/webtest.js --apply             # ... plus the Save & Apply path
node tools/webtest.js --shots shot/       # ... and screenshots
```

`tools/lint-views.js` encodes the bugs that already shipped once: a `render()`
result reaching `E()`, the `menu.d` `depends.acl` object form, and CR bytes in
anything copied to the device. It runs as the `lint` CI job, which every other
job depends on. `sh -n` is run over every on-device script in the same job.

`tools/webtest.js` is the end-to-end half, and it is the reason the render()
bug was found: a syntax check, a jsdom shim and a `curl` of the page all pass
while the page is completely blank. It logs into the router, loads both pages
in headless Edge/Chrome over CDP, records every uncaught exception and console
error, and asserts on the rendered DOM — the status table, the tailcat address,
the generated client commands, the settings form and the footer's
`Save & Apply` control. It also clicks `Show log` (a modal must open) and, with
`--apply`, drives the whole save path: UCI committed, service restarted,
success notification shown, address unchanged.

It fails loudly on the broken code, which is what makes it worth running:

```
before the fix   FAIL  tailcat: view rendered without a JS error
                       Uncaught (in promise) TypeError: html.charCodeAt is not a function
                         at ClassConstructor.create (luci.js:111:14)
                         at ClassConstructor.render (view/mt300n/tailcat.js:421:10)
                 3/7 checks passed

after the fix    28/28 checks passed
```

## Flashing

```sh
sysupgrade -T <image>     # dry run: validates metadata, flashes nothing
sysupgrade -n <image>     # -n = do not keep config (required from 21.02.x)
```

The package manager changed from `opkg` to `apk` and the switch configuration
model differs, so the old `/etc/config` is not reusable.

## Repository layout

```
.github/workflows/build.yml   CI: static checks, payload build, image build, release
.gitattributes                forces LF everywhere (device scripts must not see CR)
tools/lint-views.js           static guards, run as the lint CI job
tools/webtest.js              headless-browser regression test (needs a live router)
files/                        merged into the image (the FILES= argument)
  etc/config/{tailcat,frpc}     shipped configurations
  etc/config/mt300n             mode switch, SSIDs, AP-mode DHCP range
  etc/init.d/{tailcat,frpc}     procd services (enabled at boot)
  etc/init.d/mt300n-mode        the mode switch: mt300n-moded + mt300n-apmode
  etc/init.d/{glstatus,mt300n-payload}
  etc/profile.d/20-mt300n-path.sh
  etc/uci-defaults/99-...       first-boot defaults
  etc/uci-defaults/97-...       unique LuCI cache key per flash
  usr/bin/glstate               LED primitive
  usr/bin/glstatusd             LED state machine + debounced link probe
  usr/bin/mt300n-ctl            status/control helper (used by LuCI)
  usr/bin/mt300n-mode-switch    read the hardware switch -> router|ap
  usr/bin/mt300n-moded          follow the switch, apply the mode
  usr/bin/mt300n-mode-apply     declarative "make it this mode"
  usr/bin/mt300n-apmode         AP mode: upstream detection, wifi-only DHCP
  usr/bin/mt300n-selftest       prove the DHCP scoping on the device
  usr/bin/mt300n-tailcat-run    builds tailcat's argv from UCI and execs it
  usr/bin/mt300n-frpc-run       verifies the TOML, writes it from UCI, execs frpc
  usr/sbin/mt300n-install       fetch install.sh + packages.txt, then run it
  usr/sbin/mt300n-autorun       poll for internet, then install
  usr/sbin/mt300n-wifi-uplink   temporary STA uplink helper
  usr/share/luci/menu.d/        LuCI menu entries
  usr/share/rpcd/acl.d/         LuCI permissions
  www/luci-static/resources/view/mt300n/{tailcat,frpc}.js
  www/derpmap.json              local DERP map
payload/                      fetched at runtime, not baked into the image
  install.sh                    real installer (updatable without reflashing)
  packages.txt                  what to install and from which archive
  derpmap.json                  DERP map mirror, published to the payload branch
```
