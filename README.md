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
* **in `menu.d`, `depends.acl` must be the array form** (`["name"]`). The
  object form makes the whole LuCI UI return HTTP 500.

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

## Flashing

```sh
sysupgrade -T <image>     # dry run: validates metadata, flashes nothing
sysupgrade -n <image>     # -n = do not keep config (required from 21.02.x)
```

The package manager changed from `opkg` to `apk` and the switch configuration
model differs, so the old `/etc/config` is not reusable.

## Repository layout

```
.github/workflows/build.yml   CI: payload build, image build, release
files/                        merged into the image (the FILES= argument)
  etc/config/{tailcat,frpc}     shipped configurations
  etc/init.d/{tailcat,frpc}     procd services (enabled at boot)
  etc/init.d/{glstatus,mt300n-payload}
  etc/profile.d/20-mt300n-path.sh
  etc/uci-defaults/99-...       first-boot defaults
  usr/bin/glstate               LED primitive
  usr/bin/glstatusd             LED state machine + debounced link probe
  usr/bin/mt300n-ctl            status/control helper (used by LuCI)
  usr/bin/mt300n-tailcat-run    builds tailcat's argv from UCI and execs it
  usr/bin/mt300n-frpc-run       writes frpc.toml from UCI and execs frpc
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
