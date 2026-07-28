# Server-rendered Python fixture for the fake-backend sandbox tests. Declares
# Flask and psycopg2 in requirements.txt so classify() sees a Python server
# app, but is implemented on the standard library only — the sandbox boots it
# from a bare artifact directory with no virtualenv. It exercises everything
# the proxy must handle: HTML with root-absolute links, form POST + redirect,
# a cookie-gated page with a login endpoint, CSP/X-Frame-Options headers to
# strip, non-HTML assets, and env injection.
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

items = ["first item"]
greeting = os.environ.get("FIXTURE_GREETING", "no greeting set")


def page(body):
    return (
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="/style.css"></head>'
        f"<body>{body}</body></html>"
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the sandbox log readable
        pass

    def _send(self, status, content_type, body, extra_headers=()):
        payload = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Security-Policy", "default-src 'self'")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        for key, value in extra_headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            listing = "".join(f"<li>{i}</li>" for i in items)
            self._send(200, "text/html", page(
                f'<h1>Fixture app</h1><p id="greeting">{greeting}</p>'
                f"<ul>{listing}</ul>"
                '<form method="POST" action="/items"><input name="name"><button id="add">Add</button></form>'
                '<a href="/gated" id="gated-link">gated page</a>'
            ))
        elif path == "/gated":
            if "fixture_session=letmein" not in self.headers.get("Cookie", ""):
                self._send(403, "text/plain", "login required")
                return
            self._send(200, "text/html", page('<h1 id="secret">Secret page</h1>'))
        elif path == "/style.css":
            self._send(200, "text/css", "body { font-family: sans-serif }")
        else:
            self._send(404, "text/plain", "not found")

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        if path == "/login":
            self._send(302, "text/plain", "", (
                ("Set-Cookie", "fixture_session=letmein; Path=/; HttpOnly"),
                ("Location", "/"),
            ))
        elif path == "/items":
            name = parse_qs(body).get("name", [None])[0]
            if name:
                items.append(name)
            self._send(302, "text/plain", "", (("Location", "/"),))
        else:
            self._send(404, "text/plain", "not found")


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or 0)
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"fixture-python-app listening on {server.server_address[1]}", flush=True)
    server.serve_forever()
