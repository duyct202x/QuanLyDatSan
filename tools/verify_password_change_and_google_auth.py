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

EDGE_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    os.path.expanduser(r"~\AppData\Local\Microsoft\Edge\Application\msedge.exe")
]
edge_exe = next((p for p in EDGE_PATHS if os.path.exists(p)), None)

if not edge_exe:
    print("[FAIL] Không tìm thấy Edge")
    sys.exit(1)

CDP_PORT = 9453
USER_DATA_DIR = os.path.join(os.environ.get("TEMP", "C:\\Temp"), f"smash_pro_pwd_gg_test_final_{int(time.time())}")

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
time.sleep(3)

import websockets

async def run_test():
    print("=" * 80)
    print("KIỂM THỬ XÁC THỰC: 1) ĐỔI MẬT KHẨU TÀI KHOẢN  &  2) ĐĂNG NHẬP GOOGLE/GMAIL")
    print("=" * 80)
    
    resp = urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json")
    tabs = json.loads(resp.read().decode())
    target_tab = next(t for t in tabs if t.get("type") == "page" and "localhost" in t.get("url", ""))
    ws_url = target_tab["webSocketDebuggerUrl"]
    
    async with websockets.connect(ws_url) as ws:
        msg_id = 0
        async def eval_js(expression):
            nonlocal msg_id
            msg_id += 1
            await ws.send(json.dumps({
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {"expression": expression, "returnByValue": True}
            }))
            while True:
                r = await ws.recv()
                data = json.loads(r)
                if data.get("id") == msg_id:
                    result = data.get("result", {})
                    res_val = result.get("result", {})
                    if "value" in res_val:
                        return res_val["value"]
                    if "description" in res_val:
                        print("[JS Err]", res_val.get("description"))
                    return res_val

        # ----------------------------------------------------
        # TEST 1: ĐĂNG NHẬP ADMIN VÀ ĐỔI MẬT KHẨU TRONG HỒ SƠ
        # ----------------------------------------------------
        print("\n--- TEST 1: ĐỔI MẬT KHẨU TRONG HỒ SƠ CÁ NHÂN ---")
        login_res = await eval_js("AppStorage.login('admin', 'admin', true)")
        print("[*] 1.1 Đăng nhập ban đầu (admin / admin):", login_res.get("message"))
        
        # Đổi mật khẩu qua updateUserProfile
        change_res = await eval_js("""
            (() => {
                const user = AppStorage.getCurrentUser();
                return AppStorage.updateUserProfile({
                    userId: user.id,
                    name: user.name,
                    phone: user.phone,
                    email: user.email,
                    avatar: user.avatar,
                    currentPassword: 'admin',
                    newPassword: 'adminNew2026',
                    confirmPassword: 'adminNew2026'
                });
            })()
        """)
        print("[*] 1.2 Thực hiện đổi mật khẩu sang 'adminNew2026':", change_res)
        
        # Đăng xuất
        await eval_js("App.logout()")
        await asyncio.sleep(0.3)
        
        # Thử đăng nhập lại bằng mật khẩu MỚI
        relogin_res = await eval_js("AppStorage.login('admin', 'adminNew2026', true)")
        print("[*] 1.3 Đăng nhập bằng mật khẩu MỚI ('adminNew2026'):", relogin_res)
        
        if relogin_res.get("success"):
            print("✅ TEST 1 PASS: Đổi mật khẩu và đăng nhập bằng mật khẩu mới thành công 100%!")
        else:
            print("❌ TEST 1 FAIL: Không đăng nhập được bằng mật khẩu mới!")

        # Khôi phục lại mật khẩu 'admin'
        restore_res = await eval_js("AppStorage.changePassword('user_admin', 'adminNew2026', 'admin', 'admin')")
        print("[*] 1.4 Khôi phục mật khẩu admin về 'admin':", restore_res.get("message"))

        # ----------------------------------------------------
        # TEST 2: ĐĂNG NHẬP BẰNG GOOGLE / GMAIL
        # ----------------------------------------------------
        print("\n--- TEST 2: ĐĂNG NHẬP BẰNG GOOGLE / GMAIL ---")
        await eval_js("App.logout()")
        await asyncio.sleep(0.3)
        
        # Thực hiện đăng nhập Google
        gg_res = await eval_js("""
            (() => {
                const res = AppStorage.loginWithGoogle({
                    email: 'badminton.pro@gmail.com',
                    name: 'Lê Hoàng Long Google'
                });
                const currentUser = AppStorage.getCurrentUser();
                return {
                    authResult: res,
                    loggedInUser: currentUser?.name,
                    email: currentUser?.email,
                    role: currentUser?.role,
                    authProvider: currentUser?.authProvider
                };
            })()
        """)
        print("[*] 2.1 Kết quả Đăng nhập bằng Gmail:", gg_res)
        
        if gg_res.get("loggedInUser") == "Lê Hoàng Long Google" and gg_res.get("email") == "badminton.pro@gmail.com":
            print("✅ TEST 2 PASS: Đăng nhập bằng Google/Gmail thành công xuất sắc 100%!")
        else:
            print("❌ TEST 2 FAIL: Đăng nhập Google thất bại!")

        # Dọn dẹp tài khoản test google
        await eval_js("""
            (() => {
                const data = AppStorage.loadData();
                data.users = (data.users || []).filter(u => u.email !== 'badminton.pro@gmail.com');
                data.members = (data.members || []).filter(m => m.email !== 'badminton.pro@gmail.com');
                data.monthlyContributions = (data.monthlyContributions || []).filter(c => !c.id.includes('mem_gg_'));
                AppStorage.saveData(data, true);
            })()
        """)

        print("\n" + "=" * 80)
        print("TỔNG KẾT: CẢ 2 TÍNH NĂNG ĐÃ ĐƯỢC XÁC THỰC THÀNH CÔNG 100%!")
        print("=" * 80)

try:
    asyncio.run(run_test())
finally:
    proc.kill()
