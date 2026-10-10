import json
import time
import subprocess
import requests
import websocket
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CDP_PORT = 9227
TARGET_URL = "http://localhost:8080"

def run_test():
    print("🚀 Bắt đầu kiểm thử CDP: Xác thực nhãn 'Đồng bộ database' trên giao diện...")
    cmd = [
        EDGE_PATH,
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        f"--user-data-dir=C:\\Users\\Dcatrus\\Documents\\Projects\\QuanLyDatSan\\scratch\\cdp_badge_{int(time.time())}",
        TARGET_URL
    ]
    proc = subprocess.Popen(cmd)
    time.sleep(2)

    try:
        targets_resp = requests.get(f"http://localhost:{CDP_PORT}/json", timeout=10)
        targets = targets_resp.json()
        page_target = next((t for t in targets if t.get("type") == "page"), targets[0])
        ws_url = page_target.get("webSocketDebuggerUrl")
        ws = websocket.create_connection(ws_url, timeout=15)
        
        msg_id = 1
        def send(method, params=None):
            nonlocal msg_id
            m_id = msg_id
            msg_id += 1
            ws.send(json.dumps({"id": m_id, "method": method, "params": params or {}}))
            while True:
                res = json.loads(ws.recv())
                if res.get("id") == m_id:
                    return res

        send("Page.enable")
        send("Runtime.enable")
        send("Page.navigate", {"url": TARGET_URL})
        time.sleep(3)

        eval_badge = send("Runtime.evaluate", {
            "expression": """(() => {
                const badge = document.getElementById('cloud-sync-badge');
                const badgeText = document.getElementById('cloud-sync-text');
                return {
                    badgeExists: !!badge,
                    badgeHtml: badge ? badge.innerHTML : '',
                    text: badgeText ? badgeText.innerText : ''
                };
            })()""",
            "returnByValue": True
        })
        def get_val(resp):
            return resp.get("result", {}).get("result", {}).get("value", resp.get("result", {}).get("value", {}))

        res = get_val(eval_badge)
        print("  - Nội dung Badge:", res.get("text"))
        print("  - HTML Badge    :", res.get("badgeHtml"))

        assert "Đồng bộ database" in res.get("text"), f"Lỗi: Không tìm thấy 'Đồng bộ database' trong badge! {res.get('text')}"
        assert "Google Drive" not in res.get("text"), f"Lỗi: Vẫn còn chữ 'Google Drive' trong badge! {res.get('text')}"
        print("✅ Xác thực thành công: Nhãn 'Đồng bộ database' hiển thị chuẩn mực 100%!")

    finally:
        try:
            ws.close()
        except:
            pass
        proc.terminate()
        proc.wait(timeout=5)

if __name__ == '__main__':
    run_test()
