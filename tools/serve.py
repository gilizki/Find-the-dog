"""Local static server for the game that tells the browser not to cache, so edits show up on a normal refresh."""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # Loading the page also wipes anything the browser cached for this address earlier (e.g. old copies
        # of the game's modules saved by a plain `python -m http.server`), so it never mixes old and new files.
        if self.path.split("?")[0] in ("/", "/index.html"):
            self.send_header("Clear-Site-Data", '"cache"')
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
