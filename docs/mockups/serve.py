#!/usr/bin/env python3
"""Catch-all development server for the registers mockup.

Any path without a file on disk serves ob-registers.html, so a deep
link such as /registers/e118-iin resolves on a fresh load and the
client-side router reads the real pathname.
"""
import http.server
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.exists(path):
            self.path = '/ob-registers.html'
        return super().send_head()


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('127.0.0.1', 4173), Handler).serve_forever()
