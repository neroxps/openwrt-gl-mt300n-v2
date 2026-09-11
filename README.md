# OpenWrt 25.12.5 for the GL.iNet GL-MT300N-V2 (Mango)

Pre-built, reproducible images and a runtime payload for the
**GL.iNet GL-MT300N-V2** — MediaTek MT7628NN, `ramips/mt76x8`,
128 MB RAM, **16 MB flash**, `mipsel_24kc` (soft-float).

Everything here is built by GitHub Actions; nothing is compiled on the device.

## What gets built

| Artifact | Purpose |
| --- | --- |
| `openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin` | flashable image (`sysupgrade`) |
| `openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-initramfs-kernel.bin` | RAM-only recovery image |
| `payload-mipsel_24kc.tar.gz` | `tailscaled` (+ `tailscale` CLI) and `frpc`, statically linked for `mipsel_24kc` |

## Why the payload is not flashed

`tailscaled` and `frpc` are Go programs. Even stripped they are far larger than
the ~7 MB of free overlay on a 16 MB SPI flash, so they are installed into
**tmpfs (`/tmp/opt`)** and re-fetched after every boot.

The image itself only carries what has to survive a reboot:
WireGuard (`kmod-wireguard`, `wireguard-tools`, `luci-proto-wireguard`),
`kmod-tun` for `tailscaled`, `ca-bundle` for HTTPS, LuCI, and the boot/LED logic.

## Boot behaviour

1. WAN port requests a DHCP lease.
2. The **middle LED** (`green:wan`, gpio 43) fast-blinks while there is no
   usable internet.
3. As soon as the WAN can reach the internet, `mt300n-autorun` runs
   `mt300n-install`, which pulls `payload/install.sh` and `payload/packages.txt`
   from this repository (through the `ghfast.top` GitHub proxy) and installs the
   payload into `/tmp/opt`. The LED blinks faster during the install.
4. Once the tools are loaded the middle LED goes **solid**.

### LED map

Confirmed against the upstream device tree
`target/linux/ramips/dts/mt7628an_glinet_gl-mt300n-v2.dts`:

| sysfs name | GPIO | active | physical position |
| --- | --- | --- | --- |
| `green:power` | 42 | low | top (power) |
| `green:wan` | 43 | low | **middle (status — used here)** |
| `red:wlan` | 44 | low | wifi |

| state | middle LED | trigger |
| --- | --- | --- |
| `offline` | fast blink, 4 Hz | `timer` 125/125 ms |
| `installing` | fast blink, 6 Hz | `timer` 80/80 ms |
| `error` | fast blink, 8 Hz | `timer` 60/60 ms |
| `online` / `ready` | solid | `default-on` |

## Manual use on the device

```sh
# re-run the installer (also runs automatically at boot)
/usr/sbin/mt300n-install

# inspect state
cat /tmp/opt/INSTALLED.txt
logread | grep -E 'glstatus|mt300n'
/usr/bin/glstate offline        # force a state for testing

# tailscale
/tmp/opt/bin/tailscale up --authkey=tskey-auth-...
/tmp/opt/bin/tailscale status

# frpc - edit /tmp/opt/etc/frpc.toml first
/tmp/opt/bin/frpc -c /tmp/opt/etc/frpc.toml
```

## Environment overrides

`/usr/sbin/mt300n-install` honours `REPO`, `PROXY` and `REF`:

```sh
REPO=neroxps/openwrt-gl-mt300n-v2 PROXY=https://ghfast.top REF=main \
  /usr/sbin/mt300n-install
```

## Flashing

```sh
# from the running router
sysupgrade -n /tmp/openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin
```

`-n` is required when coming from 21.02.x: the switch/VLAN configuration model
and the package manager (`opkg` → `apk`) both changed.

## Recovery

The GL-MT300N-V2 keeps U-Boot in a read-only partition that `sysupgrade` never
touches, and it exposes U-Boot web/TFTP recovery at `192.168.1.1` (hold the
reset button while powering on). The `factory` partition holding the MAC address
and the wifi calibration data is also read-only, so a failed flash is
recoverable.
