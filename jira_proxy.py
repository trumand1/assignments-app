#!/usr/bin/env python3

import base64
import json
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error, parse, request

HOST = "127.0.0.1"
PORT = 8787


def json_bytes(payload):
    return json.dumps(payload).encode("utf-8")


def normalize_domain(raw):
    domain = (raw or "").strip()
    domain = domain.removeprefix("https://").removeprefix("http://").rstrip("/")
    return domain.lower()


def allowed_origin(origin):
    if not origin:
        return None
    parsed = parse.urlparse(origin)
    if parsed.scheme != "http":
        return None
    if parsed.hostname not in {"localhost", "127.0.0.1"}:
        return None
    return origin


def read_json(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        raise ValueError("Request body is required.")
    body = handler.rfile.read(length)
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError("Request body must be valid JSON.") from exc


def require_fields(payload, *fields):
    missing = [name for name in fields if not str(payload.get(name, "")).strip()]
    if missing:
        raise ValueError(f"Missing required field(s): {', '.join(missing)}.")


def jira_headers(email, token):
    auth = base64.b64encode(f"{email}:{token}".encode("utf-8")).decode("ascii")
    return {
        "Accept": "application/json",
        "Authorization": f"Basic {auth}",
        "Content-Type": "application/json",
        "User-Agent": "jira-local-proxy/1.0",
    }


def proxy_to_jira(method, domain, path, headers, body=None):
    url = f"https://{domain}{path}"
    req = request.Request(url, method=method, headers=headers, data=body)
    try:
        with request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            return resp.status, resp.headers.get("Content-Type", ""), raw
    except error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", ""), exc.read()
    except error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, socket.gaierror):
            raise ConnectionError(f"DNS lookup failed for {domain}. Check the Jira domain.") from exc
        raise ConnectionError(f"Could not reach Jira at {domain}: {reason}.") from exc


class JiraProxyHandler(BaseHTTPRequestHandler):
    server_version = "JiraLocalProxy/1.0"

    def end_headers(self):
        origin = allowed_origin(self.headers.get("Origin"))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
        self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            self.respond(200, {"ok": True, "service": "jira-local-proxy", "port": PORT})
            return
        self.respond(404, {"error": "Not found."})

    def do_POST(self):
        try:
            if self.path == "/api/jira/search":
                self.handle_search()
                return
            if self.path == "/api/jira/issue":
                self.handle_issue()
                return
            self.respond(404, {"error": "Not found."})
        except ValueError as exc:
            self.respond(400, {"error": str(exc)})
        except ConnectionError as exc:
            self.respond(502, {"error": str(exc)})
        except Exception as exc:  # pragma: no cover
            self.respond(500, {"error": f"Unexpected proxy error: {exc}"})

    def handle_search(self):
        payload = read_json(self)
        require_fields(payload, "email", "token", "domain", "project")

        domain = normalize_domain(payload["domain"])
        if not domain.endswith(".atlassian.net"):
            raise ValueError("Jira domain must end with .atlassian.net.")

        project = str(payload["project"]).strip().upper()
        max_results = min(max(int(payload.get("maxResults", 100)), 1), 100)
        search_payload = {
            "jql": f'project="{project}"',
            "fields": ["summary"],
            "maxResults": max_results,
        }
        next_page_token = payload.get("nextPageToken")
        if next_page_token:
            search_payload["nextPageToken"] = next_page_token

        status, content_type, raw = proxy_to_jira(
            "POST",
            domain,
            "/rest/api/3/search/jql",
            jira_headers(payload["email"], payload["token"]),
            json_bytes(search_payload),
        )
        self.respond_proxy(status, content_type, raw)

    def handle_issue(self):
        payload = read_json(self)
        require_fields(payload, "email", "token", "domain", "fields")

        domain = normalize_domain(payload["domain"])
        if not domain.endswith(".atlassian.net"):
            raise ValueError("Jira domain must end with .atlassian.net.")
        if not isinstance(payload["fields"], dict):
            raise ValueError("fields must be an object.")

        status, content_type, raw = proxy_to_jira(
            "POST",
            domain,
            "/rest/api/3/issue",
            jira_headers(payload["email"], payload["token"]),
            json_bytes({"fields": payload["fields"]}),
        )
        self.respond_proxy(status, content_type, raw)

    def respond_proxy(self, status, content_type, raw):
        if "application/json" in content_type:
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                payload = {"error": raw.decode("utf-8", errors="replace")}
        else:
            payload = {"error": raw.decode("utf-8", errors="replace") or f"HTTP {status}"}
        self.respond(status, payload)

    def respond(self, status, payload):
        data = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), JiraProxyHandler)
    print(f"Jira proxy listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Jira proxy.", flush=True)
    finally:
        server.server_close()
