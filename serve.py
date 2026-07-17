#!/usr/bin/env python3
"""
Dev server for OctoDAW with required COOP/COEP headers.
openDAW and Emscripten pthreads both need cross-origin isolation.
"""

import http.server
import socketserver
import os

class Handler(http.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.dirname(os.path.abspath(__file__)), **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

if __name__ == "__main__":
    PORT = 8080
    print(f"OctoDAW dev server: http://localhost:{PORT}")
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()
