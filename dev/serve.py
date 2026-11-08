"""Serve the app locally and reload the browser by itself whenever it changes.

    python dev/serve.py            opens http://localhost:8765 in your browser

How it works. The server watches every file in web/ and the git branch tip (.git/HEAD and refs). When anything
changes (you save a file, commit, pull, or rebuild), it tells every open page through a Server-Sent Events stream at
/__reload, and a three-line script it adds to the page reloads it. Every response says "no-store", so the browser
never shows a cached old copy: a reload is always a forced refresh. Only Python's standard library is used.
"""
import http.server, os, socketserver, threading, time, webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB, GIT = ROOT / "web", ROOT / ".git"
PORT = int(os.environ.get("PORT", 8765))
SNIPPET = b"""<script>new EventSource('/__reload').onmessage = () => location.reload();</script></body>"""
version = {"n": 0}


def fingerprint():
    files = [p for p in WEB.rglob("*") if p.is_file()]
    files += [p for p in (GIT / "HEAD", *(GIT / "refs" / "heads").rglob("*")) if p.exists() and p.is_file()]
    return tuple(sorted((str(p), p.stat().st_mtime_ns) for p in files))


def watch():
    last = fingerprint()
    while True:
        time.sleep(0.5)
        now = fingerprint()
        if now != last:
            last = now
            version["n"] += 1
            print(f"change detected, reloading pages (version {version['n']})", flush=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_GET(self):
        if self.path == "/__reload":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            seen = version["n"]
            try:
                while True:
                    if version["n"] != seen:
                        self.wfile.write(b"data: reload\n\n"); self.wfile.flush()
                        return
                    self.wfile.write(b": ping\n\n"); self.wfile.flush()
                    time.sleep(1)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
        if self.path in ("/", "/index.html"):
            body = (WEB / "index.html").read_bytes().replace(b"</body>", SNIPPET)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    Handler.extensions_map[".js"] = Handler.extensions_map[".mjs"] = "text/javascript"
    threading.Thread(target=watch, daemon=True).start()
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"Mix and Learn at {url}  (Ctrl+C to stop). Pages reload by themselves when web/ or a commit changes.")
        if not os.environ.get("NO_BROWSER"):
            webbrowser.open(url)
        httpd.serve_forever()
