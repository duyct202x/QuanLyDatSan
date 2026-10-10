import asyncio
import json
import urllib.request
import os
import subprocess
import time
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# Tìm đường dẫn Edge
EDGE_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    os.path.expanduser(r"~\AppData\Local\Microsoft\Edge\Application\msedge.exe")
]
edge_exe = next((p for p in EDGE_PATHS if os.path.exists(p)), None)

if not edge_exe:
    print("[FAIL] Không tìm thấy trình duyệt Edge.")
    sys.exit(1)

CDP_PORT = 9444
USER_DATA_DIR = os.path.join(os.environ.get("TEMP", "C:\\Temp"), "smash_pro_login_test")

cmd = [
    edge_exe,
    f"--remote-debugging-port={CDP_PORT}",
    f"--user-data-dir={USER_DATA_DIR}",
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:8080"
]

proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(2.5)

import websockets

async def run_test():
    print("=" * 80)
    print("KIỂM THỬ XÁC THỰC: ĐĂNG NHẬP TÀI KHOẢN ADMIN/admin TRÊN SMASH PRO")
    print("=" * 80)
    
    # Lấy WebSocket debugger URL
    resp = urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json")
    tabs = json.loads(resp.read().decode())
    target_tab = next(t for t in tabs if t.get("type") == "page")
    ws_url = target_tab["webSocketDebuggerUrl"]
    
    async with websockets.connect(ws_url) as ws:
        msg_id = 0
        async def send(method, params=None):
            nonlocal msg_id
            msg_id += 1
            await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
            while True:
                r = await ws.recv()
                data = json.loads(r)
                if data.get("id") == msg_id:
                    return data.get("result", {})

        await send("Page.enable")
        await send("Runtime.enable")
        
        # Đợi trang tải xong và đồng bộ Cloud
        print("[*] Đang tải trang và nạp CSDL...")
        await asyncio.sleep(2)
        
        # Thực hiện mở modal đăng nhập và đăng nhập với 'Admin' / 'admin'
        print("[*] Mở modal đăng nhập...")
        open_login_script = """
        (() => {
            App.showAuthModal('login');
            const userInp = document.getElementById('auth-login-username');
            const pwdInp = document.getElementById('auth-login-password');
            if (userInp && pwdInp) {
                userInp.value = 'Admin';
                pwdInp.value = 'admin';
                return { opened: true, userVal: userInp.value, pwdVal: pwdInp.value };
            }
            return { opened: false };
        })()
        """
        res = await send("Runtime.evaluate", {"expression": open_login_script, "returnByValue": True})
        print("[*] Điền thông tin đăng nhập:", res.get("result", {}).get("value"))
        
        # Bấm nút Đăng nhập
        print("[*] Thực hiện Đăng nhập...")
        login_script = """
        (() => {
            const form = document.getElementById('auth-login-form');
            if (form) {
                const event = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(event);
            }
            const user = AppStorage.getCurrentUser();
            const rawSession = localStorage.getItem('SMASH_PRO_AUTH_SESSION') || sessionStorage.getItem('SMASH_PRO_AUTH_SESSION');
            return {
                user: user,
                session: rawSession ? JSON.parse(rawSession) : null,
                currentUserInDb: AppStorage.loadData().currentUser?.name
            };
        })()
        """
        res = await send("Runtime.evaluate", {"expression": login_script, "returnByValue": True})
        val = res.get("result", {}).get("value", {})
        print("[*] Kết quả phiên đăng nhập:", val)
        
        user = val.get("user")
        if user and user.get("username") == "admin":
            print(f"[PASS] ĐĂNG NHẬP THÀNH CÔNG! Chào mừng {user.get('name')} (Role: {user.get('role')})")
        else:
            print("[FAIL] Đăng nhập thất bại:", val)
            
        print("=" * 80)

try:
    asyncio.run(run_test())
finally:
    proc.kill()
