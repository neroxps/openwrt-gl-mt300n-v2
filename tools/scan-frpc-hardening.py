#!/usr/bin/env python3
"""Report whether a frpc binary carries the frp-v3 fork's two hardening patches.

The fork (neroxps/frp-v3) is meant to change exactly two constants:

  pkg/util/net/websocket.go   FrpWebsocketPath  "/~!frp"        -> "/api/v1/stream"
  pkg/proto/wire/wire.go      MagicV2           "FRP\\x00\\x02\\r\\n" -> nine zero bytes

Both live in .rodata as plain bytes, so they can be looked for directly - but
NOT with grep: the second needle contains NUL bytes, and grep (PCRE included)
stops matching at the first NUL, which reports "patched" for a binary that still
carries the upstream brand string. That false negative is why this is Python.

Usage:
    python3 tools/scan-frpc-hardening.py payload/frpc-mipsel-v3
    python3 tools/scan-frpc-hardening.py --require-patched <binary>

Prints one final line of key=value pairs; exits non-zero only with
--require-patched, so CI can treat a missing patch as a warning by default and
as a hard failure once the fork ships the fix.
"""

import argparse
import pathlib
import sys

UPSTREAM_WS = b'/~!frp'
PATCHED_WS = b'/api/v1/stream'
UPSTREAM_MAGIC = b'FRP\x00\x02\r\n'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('binary')
    ap.add_argument('--require-patched', action='store_true')
    args = ap.parse_args()

    data = pathlib.Path(args.binary).read_bytes()

    ws = 'patched' if PATCHED_WS in data else ('upstream' if UPSTREAM_WS in data else 'unknown')
    magic = 'upstream' if UPSTREAM_MAGIC in data else 'patched'

    print('file           : %s (%d bytes)' % (args.binary, len(data)))
    print('websocket path : %s  (%s / %s)' % (
        ws, UPSTREAM_WS.decode('latin1'), PATCHED_WS.decode('latin1')))
    print('wire magic     : %s  (%s)' % (
        magic, 'literal FRP header present' if magic == 'upstream' else 'nine zero bytes'))
    print('websocket-path=%s wire-magic=%s' % (ws, magic))

    missing = [k for k, v in (('websocket-path', ws), ('wire-magic', magic)) if v != 'patched']
    if missing:
        print('NOT HARDENED: %s still upstream' % ', '.join(missing), file=sys.stderr)
        return 1 if args.require_patched else 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
