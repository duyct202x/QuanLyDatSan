#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Kiểm thử XSS toàn ứng dụng: mở index.html?test=true (chế độ cục bộ, không gọi máy chủ thật) trong Chrome headless,
chạy tests/xss_e2e.js (nhúng mã độc vào mọi trường dữ liệu, mở mọi màn hình/modal, bấm mọi nút)
và báo số lần mã độc được thực thi (phải = 0).
Chạy: python tools/verify_xss.py
"""
import functools
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import websocket  # websocket-client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from verify_sync_v2 import find_chrome  # noqa: E402


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    chrome = find_chrome()
    if not chrome:
        print("Không tìm thấy Chrome/Edge.")
        return 2

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=ROOT))
    httpd.handle_error = lambda *a: None
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/index.html?test=true"

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--no-first-run", f"--remote-debugging-port={port}",
                             "--remote-allow-origins=*", f"--user-data-dir={tempfile.mkdtemp()}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    exceptions = []
    try:
        for _ in range(100):
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT")
                ws_url = json.loads(urllib.request.urlopen(req, timeout=2).read())["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.2)
        ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        msg = [0]

        def call(method, params=None):
            msg[0] += 1
            ws.send(json.dumps({"id": msg[0], "method": method, "params": params or {}}))
            while True:
                r = json.loads(ws.recv())
                if r.get("id") == msg[0]:
                    return r
                if r.get("method") == "Runtime.exceptionThrown":
                    exceptions.append(r["params"]["exceptionDetails"].get("exception", {}).get("description", "")[:200])
                if r.get("method") == "Page.javascriptDialogOpening":
                    call("Page.handleJavaScriptDialog", {"accept": False})

        call("Runtime.enable")
        call("Page.enable")
        call("Page.navigate", {"url": url})
        time.sleep(3)
        with open(os.path.join(ROOT, "tests", "xss_e2e.js"), encoding="utf-8") as f:
            call("Runtime.evaluate", {"expression": f.read()})
        result = None
        deadline = time.time() + 240
        while time.time() < deadline and result is None:
            time.sleep(1)
            r = call("Runtime.evaluate", {"expression": "window.__xssResult || null", "returnByValue": True})
            result = r.get("result", {}).get("result", {}).get("value")
        ws.close()
    finally:
        proc.kill()
        httpd.shutdown()

    print(json.dumps(result, ensure_ascii=False, indent=1))
    print(f"Lỗi JS không bắt được trong lúc chạy: {len(exceptions)}")
    kinds = {}
    for e in exceptions:
        k = e.splitlines()[0][:120] if e else "?"
        kinds[k] = kinds.get(k, 0) + 1
    for k, v in sorted(kinds.items(), key=lambda x: -x[1]):
        print(f"   {v:>4} x {k}")
    ok = bool(result) and not result["hits"] and result["textVisible"]
    print("KẾT QUẢ:", "ĐẠT - không có mã độc nào được thực thi" if ok else "KHÔNG ĐẠT")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
