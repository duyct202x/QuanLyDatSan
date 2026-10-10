#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Kiểm thử tự động đồng bộ v2 (đa thiết bị, offline, nâng cấp từ v1, tương thích máy cũ).
- Chạy NGUYÊN VĂN js/storage.js + js/local-db.js + js/sync-core.js trên nhiều "thiết bị" (iframe tách biệt)
- Chạy NGUYÊN VĂN backend resources/inputs/google_apps_script_prod.js trên môi trường Apps Script giả lập
Chạy: python tools/verify_sync_v2.py
"""
import functools
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import websocket  # websocket-client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_chrome():
    for p in [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expanduser(r"~\AppData\Local\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "/usr/bin/google-chrome", "/usr/bin/chromium",
    ]:
        if os.path.exists(p):
            return p
    return None


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_gas_backend.py")], check=True)

    chrome = find_chrome()
    if not chrome:
        print("Không tìm thấy Chrome/Edge để chạy kiểm thử.")
        return 2

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=ROOT))
    httpd.handle_error = lambda *a: None  # Chrome đóng kết nối sớm: bỏ qua
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/tests/sync_v2/harness.html"

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    profile = tempfile.mkdtemp()
    proc = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--no-first-run",
                             f"--remote-debugging-port={port}", "--remote-allow-origins=*", f"--user-data-dir={profile}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    text = "(hết thời gian chờ kết quả)"
    try:
        ws_url = None
        for _ in range(100):
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?{url}", method="PUT")
                ws_url = json.loads(urllib.request.urlopen(req, timeout=2).read())["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.2)
        ws = websocket.create_connection(ws_url, timeout=10, suppress_origin=True)
        deadline = time.time() + 240
        msg_id = 0
        while time.time() < deadline:
            msg_id += 1
            ws.send(json.dumps({"id": msg_id, "method": "Runtime.evaluate", "params": {
                "expression": "document.title === 'DONE' ? document.getElementById('out').textContent : null",
                "returnByValue": True}}))
            while True:
                reply = json.loads(ws.recv())
                if reply.get("id") == msg_id:
                    break
            value = reply.get("result", {}).get("result", {}).get("value")
            if value:
                text = value
                break
            time.sleep(0.5)
        ws.close()
    finally:
        proc.kill()
        httpd.shutdown()

    print(text)
    done = re.search(r"DONE (\d+)/(\d+)", text)
    return 0 if done and done.group(1) == done.group(2) else 1


if __name__ == "__main__":
    sys.exit(main())
