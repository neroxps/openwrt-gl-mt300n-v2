#!/bin/sh
# install.sh - real payload installer, fetched from the repository by
# /usr/sbin/mt300n-install so that the logic can be updated without reflashing.
#
# Usage:  sh install.sh [packages.txt]
#
# Environment:
#   REPO=owner/name    PROXY=https://ghfast.top    REF=main    TAG=<release tag>

PKGLIST="${1:-/tmp/mt300n-install/packages.txt}"
REPO="${REPO:-neroxps/openwrt-gl-mt300n-v2}"
PROXY="${PROXY:-https://ghfast.top}"
REF="${REF:-main}"
TAG="${TAG:-}"

DEST=/tmp/opt
BIN="$DEST/bin"
RUN="$DEST/run"
VAR="$DEST/var"
FLAG=/tmp/.mt300n-installing
READY=/tmp/.mt300n-ready
ERR=/tmp/.mt300n-error

log() { logger -t mt300n-payload "$*"; echo "[payload] $*"; }
die() {
	log "FATAL: $*"
	touch "$ERR"
	rm -f "$FLAG" "$READY"
	/usr/bin/glstate error
	exit 1
}

[ -r "$PKGLIST" ] || die "package list $PKGLIST not readable"

: > "$FLAG"
/usr/bin/glstate installing

# ---------------------------------------------------------------- space ------
# Stop the services BEFORE touching the binaries.
#
# tmpfs keeps a deleted file alive as long as some process still has it open.
# Replacing tailcat/frpc while they are running therefore leaks their whole
# size - the old inode is unlinked but its pages stay charged to tmpfs, and
# neither rm nor `du` can see or reclaim them. On a 60 MB tmpfs holding a 36 MB
# payload that is fatal: the next install finds ~30 MB permanently missing and
# fails forever. Stopping the services first releases the space.
for svc in tailcat frpc; do
	[ -x "/etc/init.d/$svc" ] && /etc/init.d/"$svc" stop >/dev/null 2>&1
done
pkill -f 'bin/tailcat' 2>/dev/null
pkill -f 'bin/frpc'    2>/dev/null
sleep 2

# Reclaim the destination: an interrupted transfer leaves a half-written binary
# behind, which is unusable but still occupies tmpfs. Everything here is
# re-fetched on every boot anyway.
rm -rf "$BIN" "$DEST/stg" "$DEST"/tmp.* 2>/dev/null
mkdir -p "$BIN" "$RUN" "$VAR/lib/tailscale" "$DEST/etc"

AVAIL=$(df -k /tmp | awk 'NR==2 {print $4}')
log "tmpfs free: $((AVAIL / 1024)) MB"
[ "$AVAIL" -gt 40000 ] || die "not enough tmpfs space (${AVAIL}kB free), need ~40MB"

# ---------------------------------------------------------------- fetch ------
download() {
	# $1 = url, $2 = output file
	uclient-fetch -q -T 120 -O "$2" "$1" 2>/dev/null && [ -s "$2" ] && return 0
	rm -f "$2"
	wget -q -O "$2" "$1" 2>/dev/null && [ -s "$2" ] && return 0
	rm -f "$2"
	return 1
}

# Download an asset, verify its published SHA-256 when available, then extract
# it. The archive is removed straight away so only the extracted binaries stay
# resident. Extraction goes into a staging directory first: a truncated
# archive can therefore never leave a partial binary in $BIN.
fetch_asset() {
	ASSET="$1"
	ARC="/tmp/.$ASSET"
	STG="$DEST/stg"

	# Ordered list of sources. NOTE: GitHub's /releases/latest/download/ URL
	# answers with a 302 and the OpenWrt downloaders do not follow redirects, so
	# it is only a fallback. The raw branch URL is stable and always a plain
	# 200 through the proxy, which is why CI publishes the payload there.
	set -- \
		"${PROXY}/https://raw.githubusercontent.com/${REPO}/payload/${ASSET}" \
		"https://raw.githubusercontent.com/${REPO}/payload/${ASSET}" \
		"${PROXY}/https://github.com/${REPO}/releases/latest/download/${ASSET}" \
		"https://github.com/${REPO}/releases/latest/download/${ASSET}"

	if [ -n "$TAG" ]; then
		set -- "$@" \
			"${PROXY}/https://github.com/${REPO}/releases/download/${TAG}/${ASSET}" \
			"https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
	fi

	# The matching .sha256, when the asset has one.
	for URL in "$@"; do
		log "trying $URL"
		rm -f "$ARC"
		download "$URL" "$ARC" || continue

	# Integrity check (best effort: only when a published checksum exists).
	WANT=""
	for shaname in "${ASSET%.tar.gz}.sha256" payload.sha256 payload.tailscale.sha256; do
		rm -f /tmp/.sha
		download "$(echo "$URL" | sed "s|$ASSET\$|$shaname|")" /tmp/.sha 2>/dev/null || continue
		WANT="$(awk -v a="$ASSET" '{ n=$2; sub(/^\*/,"",n); if (n==a) { print $1; exit } }' /tmp/.sha)"
		[ -n "$WANT" ] && break
	done
	if [ -n "$WANT" ]; then
		GOT="$(sha256sum "$ARC" | cut -d' ' -f1)"
		if [ "$WANT" != "$GOT" ]; then
			log "sha256 mismatch for $ASSET ($WANT != $GOT) - trying next source"
			rm -f "$ARC" /tmp/.sha
			continue
		fi
		log "sha256 ok for $ASSET"
	fi
	rm -f /tmp/.sha

		rm -rf "$STG"
		mkdir -p "$STG"
		if tar -xzf "$ARC" -C "$STG" 2>/dev/null; then
			# Move the freshly extracted entries into place atomically enough:
			# nothing partial ever appears in $BIN.
			mkdir -p "$BIN"
			for item in "$STG"/*; do
				[ -e "$item" ] || continue
				bn="$(basename "$item")"
				if [ "$bn" = "bin" ]; then
					for f in "$item"/*; do
						[ -e "$f" ] || continue
						rm -rf "$BIN/$(basename "$f")"
						mv "$f" "$BIN/"
					done
				else
					rm -rf "$DEST/$bn"
					mv "$item" "$DEST/"
				fi
			done
			rm -rf "$STG" "$ARC"
			return 0
		fi
		log "extract failed for $ASSET"
		rm -rf "$STG" "$ARC"
	done
	return 1
}

# ---------------------------------------------------------------- install ----
# Group the requested programs by the archive they live in.
ASSETS=$(awk '!/^#/ && NF>=3 {print $2}' "$PKGLIST" | sort -u)

for A in $ASSETS; do
	log "fetching $A"
	fetch_asset "$A" || die "cannot download $A"
done

chmod +x "$BIN"/* 2>/dev/null

# ---------------------------------------------------------------- verify -----
MISSING=""
while read -r NAME ASSET PATH_IN REQUIRED; do
	case "$NAME" in ''|\#*) continue ;; esac
	[ -n "$PATH_IN" ] || continue
	SRC="$DEST/$PATH_IN"
	if [ ! -e "$SRC" ]; then
		log "MISSING $NAME ($PATH_IN)"
		MISSING="$MISSING $NAME"
		continue
	fi
	# Re-create the entry in $BIN if the archive layout differs.
	case "$PATH_IN" in
		bin/*) : ;;
		*) ln -sf "$SRC" "$BIN/$NAME" 2>/dev/null ;;
	esac
	log "ok  $NAME -> $SRC"
done < "$PKGLIST"

if [ -n "$MISSING" ]; then
	die "required programs missing:$MISSING"
fi

# ---------------------------------------------------------------- services ---
# The binaries live in tmpfs, but their configuration lives in flash
# (/etc/config/frpc and /etc/config/tailcat), so the services are ordinary
# procd services that come back on their own after a reboot. Starting them
# here just makes them live immediately after the payload has been fetched.

start_service() {
	# $1 = init script name
	if [ -x "/etc/init.d/$1" ]; then
		log "starting service: $1"
		/etc/init.d/"$1" restart >/dev/null 2>&1 || log "$1 restart returned non-zero"
	else
		log "no /etc/init.d/$1 in this image"
	fi
}

# tailcat: userspace WireGuard over Tailscale's data plane.
start_service tailcat

# frpc: stays idle until serverAddr is configured in the web UI.
start_service frpc

# Optional classic Tailscale client, if that flavour was installed instead.
if [ -x "$BIN/tailscaled" ]; then
	if ! pgrep -f 'tailscaled' >/dev/null 2>&1; then
		log "starting tailscaled (GOMEMLIMIT=24MiB)"
		GOMEMLIMIT=24MiB GOGC=50 \
		start-stop-daemon -S -b -q -x "$BIN/tailscaled" -- \
			--state="$DEST/var/lib/tailscale/tailscaled.state" \
			--socket="$RUN/tailscaled.sock" \
			--port=41641 \
			>>/tmp/opt/tailscaled.log 2>&1 || log "tailscaled start failed"
	fi
fi

# ---------------------------------------------------------------- done -------
{
	echo "installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "repo=$REPO"
	echo "proxy=$PROXY"
	ls -l "$BIN" 2>/dev/null
} > "$DEST/INSTALLED.txt"

: > "$READY"
rm -f "$FLAG"
log "payload ready in $DEST"
/usr/bin/glstate ready
exit 0
