#!/usr/bin/env python3
"""
Static server for the EchoForge browser node.

Serves the browser/ directory with the COOP/COEP headers required for
SharedArrayBuffer and WebGPU multi-threading, and gzip/brotli compression
for faster initial load.

Usage:
    python packages/ruvon-echoforge/browser/serve.py          # port 8080
    python packages/ruvon-echoforge/browser/serve.py 9000

Then open: http://localhost:8080/
"""

import gzip
import http.server
import os
import socketserver
import sys
import threading
from pathlib import Path

COMPRESSIBLE = {".js", ".mjs", ".html", ".css", ".json", ".txt", ".yaml", ".yml"}
DEMO_DIR     = Path(__file__).resolve().parent

_cache: dict = {}
_cache_lock  = threading.Lock()

try:
    import brotli as _brotli
    _HAS_BROTLI = True
except ImportError:
    _HAS_BROTLI = False


class EchoForgeHandler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/index.html")
            self.end_headers()
            return

        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()

        ext = Path(path).suffix.lower()
        if ext not in COMPRESSIBLE:
            return super().do_GET()

        accept   = self.headers.get("Accept-Encoding", "")
        encoding = None
        if _HAS_BROTLI and "br" in accept:
            encoding = "br"
        elif "gzip" in accept:
            encoding = "gzip"

        if encoding is None:
            return super().do_GET()

        mtime     = os.path.getmtime(path)
        cache_key = (path, encoding, mtime)
        with _cache_lock:
            if cache_key not in _cache:
                data = Path(path).read_bytes()
                _cache[cache_key] = (
                    _brotli.compress(data, quality=6) if encoding == "br"
                    else gzip.compress(data, compresslevel=6)
                )
            compressed = _cache[cache_key]

        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(compressed)))
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(compressed)

    def end_headers(self):
        # Required for SharedArrayBuffer + WebGPU worklets
        self.send_header("Cross-Origin-Opener-Policy",   "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        # Always revalidate — prevents stale ONNX model files from being served
        # from cache after an on-disk update. 304 is returned when unchanged.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if len(args) >= 2 and args[1] in ("200", "304"):
            return
        super().log_message(fmt, *args)


class _Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads      = True


PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
mode = "brotli + gzip" if _HAS_BROTLI else "gzip"

print(f"\n  EchoForge browser node")
print(f"  http://localhost:{PORT}/   [{mode} compression]")
print(f"  Press Ctrl-C to stop.\n")

os.chdir(DEMO_DIR)

httpd = _Server(("", PORT), EchoForgeHandler)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    httpd.shutdown()
    httpd.server_close()
    print("\nStopped.")
    sys.exit(0)
