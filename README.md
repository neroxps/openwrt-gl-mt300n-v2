# OpenWrt 25.12.5 for the GL.iNet GL-MT300N-V2 (Mango)

Pre-built, reproducible image plus a runtime payload for the
**GL.iNet GL-MT300N-V2** — MediaTek MT7628NN, `ramips/mt76x8`,
128 MB RAM, **16 MB flash**, `mipsel_24kc` (soft-float).

Everything is built by GitHub Actions; nothing is compiled on the device.

## What gets built

| Artifact | Purpose |
| --- | --- |
| `openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin` | flashable image (`sysupgrade`) |
| `payload-mipsel_24kc.tar.gz` | `tailscaled` (+ `tailscale` CLI) and `frpc`, cross-compiled for `mipsel_24kc` |

The payload is published twice: as a release asset and as a plain file on the
`payload` branch. **The device uses the branch copy**, because GitHub's
`/releases/latest/download/` URL answers with a 302 redirect and the OpenWrt
downloaders (`uclient-fetch`/`wget`) do not follow redirects — through the
GitHub proxy the raw branch URL is always a clean `200`.

## Why the payload is not flashed

`tailscaled` and `frpc` are Go programs. Stripped they are still ~46 MB
combined, which does not fit in the ~9.3 MB of free overlay on a 16 MB SPI
flash. They are installed into **tmpfs (`/tmp/opt`)** and re-fetched after each
boot.

The image only carries what must survive a reboot:

* WireGuard — `kmod-wireguard`, `wireguard-tools`, `luci-proto-wireguard`
* `kmod-tun` — required by `tailscaled`
* `ca-bundle` — HTTPS to GitHub
* full LuCI (with `wpad-basic-mbedtls`, which supports both AP and **STA** mode)
* the boot + LED logic in `files/`

Final image size is **6.29 MB** (stock 25.12.5 for this device is 6.10 MB).

### Payload size engineering

Official upstream binaries are unusable here — they carry full DWARF debug info:

| binary | upstream `mipsle` | this build (stripped, tags) |
| --- | --- | --- |
| `tailscaled` | 38.9 MB (+32.2 MB CLI, i.e. 71 MB) | **30.4 MB** (single binary, CLI included) |
| `frpc` | 16.6 MB | **17.1 MB** |
| **total** | **~88 MB** | **~46 MB** |

Tailscale is built exactly the way OpenWrt does it: one `tailscaled` binary with
`ts_include_cli` (so it also serves as the `tailscale` CLI via a symlink) plus
`ts_omit_aws,bird,completion,kube,systray,taildrop,tap,tpm`. `frpc` is taken as
a single binary instead of the whole `frp` release.

### Memory

There is **no swap on this target**: the ramips/mt76x8 kernel is built without
`CONFIG_SWAP`, so `/proc/swaps` does not exist and `zram` cannot help. The
payload therefore permanently occupies ~46 MB of the 120 MB usable RAM, and
`tailscaled` is started with `GOMEMLIMIT=24MiB GOGC=50` to keep its RSS around
30 MB rather than growing until the OOM killer intervenes.

Measured on the device with `tailscaled` running:

```
MemTotal: 122984 kB   MemFree: 24064 kB   MemAvailable: 11592 kB
Cached: 68808 kB  (of which Shmem 46916 kB = the tmpfs payload)
tailscaled RSS: ~32 MB
```

## Boot behaviour

1. The WAN port (`eth0.2`) requests a DHCP lease.
2. The **middle LED** (`green:wan`) fast-blinks while there is no usable internet.
3. Once the WAN can reach the internet, the `mt300n-payload` service runs
   `mt300n-install`, which pulls `payload/install.sh` and `payload/packages.txt`
   from this repository through the `ghfast.top` GitHub proxy and installs the
   payload into `/tmp/opt`. The LED blinks faster during the install.
4. Once the tools are loaded and `tailscaled` is running the middle LED goes
   **solid**.

Current state is visible any time with:

```sh
logread | grep -E 'glstatus|mt300n'
```

which prints transitions such as:

```
user.notice glstatus: state=offline      # no internet   -> fast blink
user.notice glstatus: state=online       # internet up    -> solid
user.notice mt300n-payload: fetching payload-mipsel_24kc.tar.gz
user.notice glstatus: state=installing   # downloading    -> faster blink
user.notice glstatus: state=ready        # tools loaded   -> solid
```

### LED map

Confirmed against the upstream device tree
`target/linux/ramips/dts/mt7628an_glinet_gl-mt300n-v2.dts` in OpenWrt 25.12.5:

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

The link probe is debounced (3 consecutive failures before the LED leaves the
solid state), otherwise a single lost ICMP packet makes the LED flicker.

## Staying in control after a flash

A `sysupgrade -n` wipes the configuration, so the image is built to be
reachable no matter what:

* LAN is always `192.168.1.1/24` on `br-lan`, and `99-gl-mt300n-v2` re-asserts
  it if it is ever missing.
* `dropbear` keeps `PasswordAuth` and `RootPasswordAuth` on for the `lan`
  interface (a freshly flashed OpenWrt has an empty root password).
* CI bakes the `SSH_AUTHORIZED_KEY` repository secret into
  **both** `/etc/dropbear/authorized_keys` and `/root/.ssh/authorized_keys`,
  so key login works even with a reset configuration.
* U-Boot lives in a read-only partition that `sysupgrade` never touches, and
  the device exposes U-Boot web/TFTP recovery at `192.168.1.1` (hold reset
  while powering on). The read-only `factory` partition holds the MAC address
  and wifi calibration data, so a failed flash is recoverable.

## Using the device

```sh
# re-run the installer (also runs automatically at boot)
/usr/sbin/mt300n-install

# inspect
cat /tmp/opt/INSTALLED.txt
logread | grep -E 'glstatus|mt300n'
/usr/bin/glstate offline            # force a state, for testing

# tailscale
/tmp/opt/bin/tailscale --socket=/tmp/opt/run/tailscaled.sock up --authkey=tskey-auth-...
/tmp/opt/bin/tailscale --socket=/tmp/opt/run/tailscaled.sock status

# frpc - edit /tmp/opt/etc/frpc.toml first (serverAddr + auth.token)
/tmp/opt/bin/frpc -c /tmp/opt/etc/frpc.toml
```

### Temporary Wi-Fi uplink (testing aid)

The WAN port needs a cable. To give the router internet without one — for
example to let it fetch the payload — it can be temporarily associated with an
upstream access point:

```sh
/usr/sbin/mt300n-wifi-uplink on "Nero_Home" "461701018"
/usr/sbin/mt300n-wifi-uplink off      # remove every trace of it
```

`on` creates a station interface *next to* the existing AP (the MT7628 radio
supports concurrent VAPs), pins its name with `ifname` (without that netifd
cannot bind the device and reports `NO_DEVICE`), and adds it to the `wan`
firewall zone so it provides the default route exactly like Ethernet WAN.

`off` removes the station, the interface and the zone membership, restoring the
wired-WAN-only configuration.

### Environment overrides

`/usr/sbin/mt300n-install` honours `REPO`, `PROXY` and `REF`:

```sh
REPO=neroxps/openwrt-gl-mt300n-v2 PROXY=https://ghfast.top REF=main \
  /usr/sbin/mt300n-install
```

## Flashing

```sh
sysupgrade -n /tmp/openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin
```

`-n` (do not keep config) is required coming from 21.02.x: the package manager
changed from `opkg` to `apk`, and the old `/etc/config` is not reusable.

Before flashing, confirm the image is accepted:

```sh
sysupgrade -T <image>      # dry run: validates metadata, flashes nothing
```

## Repository layout

```
.github/workflows/build.yml   CI: payload build, image build, release
files/                        files merged into the image (the FILES= argument)
  etc/init.d/glstatus           procd service: LED state machine
  etc/init.d/mt300n-payload     procd service: re-install payload after boot
  etc/uci-defaults/99-...       first-boot defaults (hostname, LEDs, ssh, LAN)
  usr/bin/glstate               LED primitive (blink/solid/off)
  usr/bin/glstatusd             state machine + debounced link probe
  usr/sbin/mt300n-install       fetch install.sh + packages.txt, then run it
  usr/sbin/mt300n-autorun       wait for internet, then run the installer
  usr/sbin/mt300n-wifi-uplink   temporary STA uplink helper
payload/                      fetched at runtime, not baked into the image
  install.sh                    real installer (updatable without reflashing)
  packages.txt                  what to install and from which archive
```
