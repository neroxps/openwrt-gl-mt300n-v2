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
die() { log "FATAL: $*"; touch "$ERR"; rm -f "$FLAG"; /usr/bin/glstate error; exit 1; }

[ -r "$PKGLIST" ] || die "package list $PKGLIST not readable"

: > "$FLAG"
/usr/bin/glstate installing

# ---------------------------------------------------------------- space ------
mkdir -p "$BIN" "$RUN" "$VAR/lib/tailscale" "$DEST/etc"
AVAIL=$(df -k /tmp | awk 'NR==2 {print $4}')
log "tmpfs free: $((AVAIL / 1024)) MB"
[ "$AVAIL" -gt 25000 ] || die "not enough tmpfs space (${AVAIL}kB free), need ~25MB"

# ---------------------------------------------------------------- fetch ------
# Download an asset and stream it straight into tar, so the archive is never
# stored twice in RAM.
fetch_stream() {
	ASSET="$1"

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

	for URL in "$@"; do
		log "trying $URL"
		if uclient-fetch -q -O - "$URL" 2>/dev/null | tar -xzf - -C "$DEST" 2>/dev/null; then
			return 0
		fi
		if wget -q -O - "$URL" 2>/dev/null | tar -xzf - -C "$DEST" 2>/dev/null; then
			return 0
		fi
	done
	return 1
}

# ---------------------------------------------------------------- install ----
# Group the requested programs by the archive they live in.
ASSETS=$(awk '!/^#/ && NF>=3 {print $2}' "$PKGLIST" | sort -u)

for A in $ASSETS; do
	log "fetching $A"
	fetch_stream "$A" || die "cannot download $A"
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
# tailscaled: state and socket live in tmpfs as well.
#
# This target has 128 MB of RAM and NO swap (the mt76x8 kernel is built without
# CONFIG_SWAP), and 46 MB of the RAM is permanently occupied by the payload in
# tmpfs. tailscaled is a Go program, so cap its heap explicitly with GOMEMLIMIT
# and make the collector work a little harder; that keeps its RSS around 30 MB
# instead of letting it grow until the OOM killer steps in.
if [ -x "$BIN/tailscaled" ]; then
	if ! pgrep -f 'tailscaled' >/dev/null 2>&1; then
		log "starting tailscaled (GOMEMLIMIT=24MiB)"
		GOMEMLIMIT=24MiB GOGC=50 \
		start-stop-daemon -S -b -q -x "$BIN/tailscaled" -- \
			--state="$VAR/lib/tailscale/tailscaled.state" \
			--socket="$RUN/tailscaled.sock" \
			--port=41641 \
			>>/tmp/opt/tailscaled.log 2>&1 || log "tailscaled start failed"
	fi
fi

# frpc: only started when a config with a server exists.
FRPC_CONF="$DEST/etc/frpc.toml"
if [ ! -f "$FRPC_CONF" ]; then
	cat > "$FRPC_CONF" <<-'EOF'
	# frpc configuration for GL-MT300N-V2.
	# Fill in serverAddr/serverPort and token, then run:
	#   /tmp/opt/bin/frpc -c /tmp/opt/etc/frpc.toml
	# or simply re-run:  /usr/sbin/mt300n-install
	serverAddr = ""
	serverPort = 7000
	# Keep retrying instead of exiting when the server is briefly unreachable.
	loginFailExit = false
	auth.method = "token"
	auth.token = ""

	[[proxies]]
	name = "mt300n-ssh"
	type = "tcp"
	localIP = "127.0.0.1"
	localPort = 22
	remotePort = 6022
	EOF
	log "wrote default frpc config to $FRPC_CONF"
fi

if [ -x "$BIN/frpc" ]; then
	if grep -qE '^[[:space:]]*serverAddr[[:space:]]*=[[:space:]]*"[^"]+"' "$FRPC_CONF" 2>/dev/null; then
		if ! pgrep -f 'frpc' >/dev/null 2>&1; then
			log "starting frpc"
			start-stop-daemon -S -b -q -x "$BIN/frpc" -- -c "$FRPC_CONF" \
				>>/tmp/opt/frpc.log 2>&1 || log "frpc start failed"
		fi
	else
		log "frpc installed but not started: serverAddr is empty in $FRPC_CONF"
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
