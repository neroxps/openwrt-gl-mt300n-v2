#!/bin/sh
# Put the runtime payload in the PATH.
#
# tailcat and frpc live in tmpfs (/tmp/opt/bin) because they do not fit in the
# 16 MB flash. This makes them available as ordinary commands in every login
# shell.
#
# The directory is populated by /usr/sbin/mt300n-install at boot, once the WAN
# has internet.

MT300N_BIN=/tmp/opt/bin

case ":$PATH:" in
	*":$MT300N_BIN:"*) ;;
	*) PATH="$MT300N_BIN:$PATH" ;;
esac
export PATH
