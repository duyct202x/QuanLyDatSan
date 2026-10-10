import os
import sys
import json
import time
import subprocess
import urllib.request
import websocket

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        pass

EDGE_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
]

def find_edge():
    for p in EDGE_PATHS:
        if os.path.exists(p):
            return p
    return None

class SimpleCDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=10)
        self.msg_id = 1

    def send(self, method, params=None):
        mid = self.msg_id
        self.msg_id += 1
        payload = {"id": mid, "method": method, "params": params or {}}
        self.ws.send(json.dumps(payload))
        while True:
            resp = json.loads(self.ws.recv())
            if resp.get("id") == mid:
                return resp.get("result", {})

    def evaluate(self, expr):
        res = self.send("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": True
        })
        if "exceptionDetails" in res.get("result", {}):
            print("[-] Exception in evaluate:", res["result"]["exceptionDetails"])
        elif "result" in res:
            return res["result"].get("value")
        return res.get("value")

    def close(self):
        try:
            self.ws.close()
        except:
            pass

def main():
    print("=" * 70)
    print("KIỂM THỬ XÁC THỰC: HỆ THỐNG ĐĂNG NHẬP / ĐĂNG KÝ CHUẨN MỰC & AN TOÀN")
    print("=" * 70)

    edge_exe = find_edge()
    if not edge_exe:
        print("[-] Không tìm thấy Microsoft Edge!")
        sys.exit(1)

    port = 9445
    user_data = os.path.join(os.getcwd(), "scratch", "cdp_clean_auth_test")
    os.makedirs(user_data, exist_ok=True)

    cmd = [
        edge_exe,
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={user_data}",
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "http://localhost:8080"
    ]

    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)

    try:
        targets_url = f"http://127.0.0.1:{port}/json"
        req = urllib.request.urlopen(targets_url)
        targets = json.loads(req.read().decode())
        page_target = next((t for t in targets if t.get("type") == "page"), None)

        if not page_target or "webSocketDebuggerUrl" not in page_target:
            print("[-] Không kết nối được CDP WebSocket!")
            sys.exit(1)

        cdp = SimpleCDP(page_target["webSocketDebuggerUrl"])
        print("[+] Đã kết nối CDP WebSocket thành công.")

        time.sleep(1.5)
        print("\n--- TEST 1: XÁC THỰC LOẠI BỎ TOÀN BỘ PHẦN TỬ GMAIL / GOOGLE ---")
        res1 = cdp.evaluate("""
            (() => {
                const googleScript = document.querySelector('script[src*="accounts.google.com"]');
                const googleBtn = document.getElementById('btn-google-auth-trigger');
                const googleBannerInAuth = document.querySelector('.google-reg-banner');
                const googleInApp = typeof App.handleGoogleLogin === 'function' || typeof App.initGoogleIdentityServices === 'function';
                const googleInStorage = typeof AppStorage.loginWithGoogle === 'function';

                return {
                    hasGoogleScript: !!googleScript,
                    hasGoogleBtn: !!googleBtn,
                    hasGoogleBanner: !!googleBannerInAuth,
                    googleInApp: googleInApp,
                    googleInStorage: googleInStorage
                };
            })()
        """)
        print("[*] 1.1 Kết quả kiểm tra tàn dư Google:", res1)
        assert res1.get("hasGoogleScript") == False, "Vẫn còn script Google Identity Services trong HTML!"
        assert res1.get("hasGoogleBtn") == False, "Vẫn còn nút Google Auth trong Auth Modal!"
        assert res1.get("hasGoogleBanner") == False, "Vẫn còn banner Google trong Form Đăng ký!"
        assert res1.get("googleInApp") == False, "Vẫn còn hàm Google trong App!"
        assert res1.get("googleInStorage") == False, "Vẫn còn hàm Google trong AppStorage!"
        print("✅ TEST 1 PASS: Đã gỡ bỏ 100% toàn bộ cơ chế đăng nhập Gmail/Google theo đúng chỉ đạo!")

        # TEST 2: KIỂM TRA QUY TRÌNH ĐĂNG KÝ VÀ ĐĂNG NHẬP CHUẨN MẬT KHẨU SHA-256
        print("\n--- TEST 2: ĐĂNG KÝ & ĐĂNG NHẬP TÀI KHOẢN CHUẨN MỰC ---")
        res2 = cdp.evaluate("""
            (() => {
                // 0. Dọn dẹp tài khoản test cũ nếu có
                const dataBefore = AppStorage.loadData();
                dataBefore.users = (dataBefore.users || []).filter(u => u.username !== '0966554433' && u.phone !== '0966554433');
                dataBefore.members = (dataBefore.members || []).filter(m => m.phone !== '0966554433');
                AppStorage.saveData(dataBefore, false);

                // 1. Đăng ký tài khoản mới qua form chuẩn
                const regRes = AppStorage.register({
                    name: "Nguyễn Văn Bảo Mật",
                    phone: "0966554433",
                    usernameInput: "0966554433",
                    password: "SecurePass@2026",
                    confirmPassword: "SecurePass@2026",
                    memberType: "fixed",
                    remember: true
                });

                const data = AppStorage.loadData();
                const newUser = data.users.find(u => u.username === 'baomat2026' || u.phone === '0966554433');
                const newMember = data.members.find(m => m.phone === '0966554433');
                const isHashed = newUser?.password?.startsWith('$sha256$');

                // 2. Đăng xuất và đăng nhập lại bằng SĐT / Username
                AppStorage.logout(true);
                const loginRes = AppStorage.login('0966554433', 'SecurePass@2026', true);

                return {
                    regSuccess: regRes.success,
                    userCreated: !!newUser,
                    isHashed: isHashed,
                    memberCreated: !!newMember,
                    loginSuccess: loginRes.success,
                    loggedInName: loginRes.user?.name
                };
            })()
        """)
        print("[*] 2.1 Kết quả Đăng ký & Đăng nhập bảo mật:", res2)
        assert res2.get("regSuccess") == True, "Đăng ký tài khoản thất bại!"
        assert res2.get("isHashed") == True, "Mật khẩu không được băm SHA-256!"
        assert res2.get("loginSuccess") == True, "Đăng nhập lại thất bại!"
        assert res2.get("loggedInName") == "Nguyễn Văn Bảo Mật", "Tên người dùng không đúng!"
        print("✅ TEST 2 PASS: Quy trình Đăng ký và Đăng nhập chuẩn SHA-256 hoạt động an toàn 100%!")

        # TEST 3: KIỂM TRA ĐỔI MẬT KHẨU TRONG HỒ SƠ CÁ NHÂN
        print("\n--- TEST 3: ĐỔI MẬT KHẨU TRONG HỒ SƠ CÁ NHÂN ---")
        res3 = cdp.evaluate("""
            (() => {
                const user = AppStorage.getCurrentUser();
                const changeRes = AppStorage.updateUserProfile({
                    userId: user.id,
                    name: user.name,
                    phone: user.phone,
                    currentPassword: 'SecurePass@2026',
                    newPassword: 'NewSecurePass@2026',
                    confirmPassword: 'NewSecurePass@2026'
                });

                // Kiểm tra đăng nhập lại bằng mật khẩu mới
                AppStorage.logout(true);
                const loginNew = AppStorage.login('0966554433', 'NewSecurePass@2026', true);
                const loginOld = AppStorage.login('0966554433', 'SecurePass@2026', true);

                return {
                    changeSuccess: changeRes.success,
                    changeMsg: changeRes.message,
                    loginNewSuccess: loginNew.success,
                    loginOldSuccess: loginOld.success
                };
            })()
        """)
        print("[*] 3.1 Kết quả Đổi mật khẩu:", res3)
        assert res3.get("changeSuccess") == True, "Đổi mật khẩu thất bại!"
        assert res3.get("loginNewSuccess") == True, "Đăng nhập bằng mật khẩu mới thất bại!"
        assert res3.get("loginOldSuccess") == False, "Đăng nhập bằng mật khẩu cũ vẫn thành công (LỖI)!"
        print("✅ TEST 3 PASS: Đổi mật khẩu và xác thực SHA-256 hoạt động chính xác tuyệt đối!")

        # DỌN DẸP DỮ LIỆU TEST
        cdp.evaluate("""
            (() => {
                const data = AppStorage.loadData();
                data.users = (data.users || []).filter(u => u.username !== 'baomat2026');
                data.members = (data.members || []).filter(m => m.phone !== '0966554433');
                AppStorage.saveData(data, false);
                AppStorage.logout(true);
            })()
        """)

        print("\n" + "=" * 70)
        print("TẤT CẢ 3/3 BÀI KIỂM THỬ XÁC THỰC HỆ THỐNG ĐẠT 100% PASSED!")
        print("=" * 70)

        cdp.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except:
            proc.kill()

if __name__ == "__main__":
    main()
