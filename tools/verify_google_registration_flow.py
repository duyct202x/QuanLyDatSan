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
        return res.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except:
            pass

def main():
    print("=" * 70)
    print("KIỂM THỬ TOÀN DIỆN CƠ CHẾ ĐĂNG KÝ VÀ ĐĂNG NHẬP VỚI GMAIL / GOOGLE")
    print("=" * 70)

    edge_exe = find_edge()
    if not edge_exe:
        print("[-] Không tìm thấy Microsoft Edge!")
        sys.exit(1)

    port = 9444
    user_data = os.path.join(os.getcwd(), "scratch", "cdp_google_reg_test")
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

        # Đợi ứng dụng nạp
        time.sleep(1)

        # TEST 1: KIỂM TRA GIAO DIỆN AUTH MODAL & NÚT GOOGLE SIGN-IN
        print("\n--- TEST 1: KIỂM TRA GIAO DIỆN AUTH MODAL & DYNAMIC GOOGLE LABEL ---")
        res1 = cdp.evaluate("""
            (() => {
                App.showAuthModal('login');
                const loginLabel = document.getElementById('btn-google-auth-label')?.textContent?.trim();
                
                App.switchAuthTab('register');
                const regLabel = document.getElementById('btn-google-auth-label')?.textContent?.trim();
                const regBanner = document.querySelector('.google-reg-banner');
                
                return {
                    loginLabel,
                    regLabel,
                    hasRegBanner: !!regBanner,
                    regBannerText: regBanner ? regBanner.innerText : ''
                };
            })()
        """)
        print("[*] 1.1 Kết quả hiển thị Auth Modal:", res1)
        assert res1.get("loginLabel") == "Tiếp tục với Google / Gmail" or "Google" in res1.get("loginLabel", ""), "Label nút Google ở tab Login không đúng!"
        assert res1.get("regLabel") == "Đăng ký nhanh bằng Google / Gmail", "Label nút Google ở tab Register không đúng!"
        assert res1.get("hasRegBanner") == True, "Không tìm thấy banner Google One-Tap Register trong form đăng ký!"
        print("✅ TEST 1 PASS: Giao diện Auth Modal và chuyển đổi Tab Login/Register hoàn hảo!")

        # TEST 2: KIỂM TRA GIAO DIỆN ĐĂNG KÝ GIA NHẬP CLB TRONG TAB THÀNH VIÊN
        print("\n--- TEST 2: KIỂM TRA SUBTAB ĐĂNG KÝ GIA NHẬP CLB (#MEMBERS) ---")
        res2 = cdp.evaluate("""
            (() => {
                App.openTab('members');
                MembersModule.switchSubTab('register');
                const regSubtab = document.getElementById('subtab-panel-members-reg');
                const bannerInSubtab = regSubtab ? regSubtab.querySelector('.auth-divider') : null;
                const regBtn = regSubtab ? regSubtab.querySelector('button[onclick*="handleGoogleLogin"]') : null;
                return {
                    regSubtabDisplay: regSubtab ? regSubtab.style.display : null,
                    hasGoogleBtn: !!regBtn,
                    btnText: regBtn ? regBtn.innerText.trim() : ''
                };
            })()
        """)
        print("[*] 2.1 Kết quả hiển thị Subtab Đăng ký thành viên:", res2)
        assert res2.get("hasGoogleBtn") == True, "Không tìm thấy nút Đăng ký Google trong subtab đăng ký CLB!"
        print("✅ TEST 2 PASS: Banner đăng ký nhanh Gmail trong Tab Thành viên hiển thị chuẩn xác!")

        # TEST 3: THỰC THI ĐĂNG KÝ THÀNH VIÊN MỚI QUA GMAIL (ONE-TAP ZERO-PASSWORD)
        print("\n--- TEST 3: ĐĂNG KÝ THÀNH VIÊN MỚI QUA GMAIL ---")
        res3 = cdp.evaluate("""
            (() => {
                // Xóa tài khoản test cũ nếu có
                const dataBefore = AppStorage.loadData();
                dataBefore.users = (dataBefore.users || []).filter(u => u.email !== 'badminton.star2026@gmail.com');
                dataBefore.members = (dataBefore.members || []).filter(m => m.email !== 'badminton.star2026@gmail.com');
                AppStorage.saveData(dataBefore, false);

                // Thực hiện Đăng ký tài khoản qua Gmail
                const regResult = AppStorage.loginWithGoogle({
                    email: 'badminton.star2026@gmail.com',
                    name: 'Trần Cầu Lông Pro',
                    avatar: 'https://ui-avatars.com/api/?name=Tran+Cau+Long&background=10b981&color=fff',
                    phone: '0977889900',
                    memberType: 'fixed',
                    googleId: 'gid_google_test_9999'
                });

                const dataAfter = AppStorage.loadData();
                const newUser = dataAfter.users.find(u => u.email === 'badminton.star2026@gmail.com');
                const newMember = dataAfter.members.find(m => m.email === 'badminton.star2026@gmail.com');
                const currentMonth = new Date().toISOString().slice(0, 7);
                const newDue = (dataAfter.monthlyContributions || []).find(d => d.memberId === newMember?.id && d.month === currentMonth);
                const session = JSON.parse(localStorage.getItem('SMASH_PRO_AUTH_SESSION_V2') || '{}');

                return {
                    regResult,
                    isNew: regResult.isNew,
                    userCreated: !!newUser,
                    userName: newUser?.name,
                    userRole: newUser?.role,
                    userType: newUser?.type,
                    userPhone: newUser?.phone,
                    authProvider: newUser?.authProvider,
                    memberCreated: !!newMember,
                    memberId: newMember?.id,
                    dueCreated: !!newDue,
                    dueAmount: newDue?.amount,
                    sessionUserId: session.id,
                    sessionAuthProvider: session.authProvider
                };
            })()
        """)
        print("[*] 3.1 Kết quả Đăng ký thành viên mới qua Gmail:", res3)
        assert res3.get("isNew") == True, "Cờ isNew phải là True khi đăng ký tài khoản mới!"
        assert res3.get("userCreated") == True, "User chưa được tạo trong CSDL!"
        assert res3.get("userName") == "Trần Cầu Lông Pro", "Tên User không đúng!"
        assert res3.get("userPhone") == "0977889900", "Số điện thoại không đúng!"
        assert res3.get("authProvider") == "google", "Auth Provider phải là google!"
        assert res3.get("memberCreated") == True, "Hồ sơ Thành viên CLB chưa được tạo!"
        assert res3.get("dueCreated") == True, "Bản ghi đóng quỹ tháng chưa được tạo tự động!"
        assert res3.get("sessionAuthProvider") == "google", "Session chưa được lưu chính xác!"
        print("✅ TEST 3 PASS: Đăng ký thành viên mới qua Gmail thành công 100% với đầy đủ User, Member và Quỹ tháng!")

        # TEST 4: ĐĂNG NHẬP LẠI VỚI TÀI KHOẢN GMAIL VỪA TẠO
        print("\n--- TEST 4: ĐĂNG NHẬP LẠI VỚI TÀI KHOẢN GMAIL SẴN CÓ ---")
        res4 = cdp.evaluate("""
            (() => {
                // Đăng xuất trước
                App.logout();

                // Đăng nhập lại với tài khoản Gmail vừa tạo
                const loginResult = AppStorage.loginWithGoogle({
                    email: 'badminton.star2026@gmail.com',
                    googleId: 'gid_google_test_9999'
                });

                const session = JSON.parse(localStorage.getItem('SMASH_PRO_AUTH_SESSION_V2') || '{}');
                const currentUser = AppStorage.getCurrentUser();

                return {
                    loginResult,
                    isNew: loginResult.isNew,
                    sessionName: session.name,
                    currentUserName: currentUser?.name,
                    currentUserEmail: currentUser?.email
                };
            })()
        """)
        print("[*] 4.1 Kết quả Đăng nhập lại qua Gmail:", res4)
        assert res4.get("isNew") == False, "Cờ isNew phải là False khi đăng nhập lại tài khoản đã có!"
        assert res4.get("currentUserName") == "Trần Cầu Lông Pro", "Tên User đăng nhập lại không đúng!"
        assert res4.get("currentUserEmail") == "badminton.star2026@gmail.com", "Email User đăng nhập lại không đúng!"
        print("✅ TEST 4 PASS: Đăng nhập lại tài khoản Gmail sẵn có hoạt động mượt mà, chính xác!")

        # TEST 5: KIỂM TRA POPUP GOOGLE ACCOUNT CHOOSER
        print("\n--- TEST 5: KIỂM TRA GOOGLE ACCOUNT CHOOSER MODAL ---")
        res5 = cdp.evaluate("""
            (() => {
                App.handleGoogleLogin('register');
                const title = document.getElementById('global-modal-title')?.textContent?.trim();
                const body = document.getElementById('global-modal-body');
                const emailInput = document.getElementById('google-auth-email');
                const nameInput = document.getElementById('google-auth-name');
                const phoneInput = document.getElementById('google-auth-phone');
                const typeSelect = document.getElementById('google-auth-member-type');
                const scanBtn = body ? body.querySelector('button[onclick*="triggerBrowserGoogleOneTap"]') : null;

                return {
                    title,
                    hasEmailInput: !!emailInput,
                    hasNameInput: !!nameInput,
                    hasPhoneInput: !!phoneInput,
                    hasTypeSelect: !!typeSelect,
                    hasScanBtn: !!scanBtn
                };
            })()
        """)
        print("[*] 5.1 Kết quả hiển thị Google Account Chooser Modal:", res5)
        assert "Đăng ký" in res5.get("title", ""), "Tiêu đề modal khi mở ở chế độ register phải chứa 'Đăng ký'!"
        assert res5.get("hasEmailInput") == True, "Thiếu input Email!"
        assert res5.get("hasPhoneInput") == True, "Thiếu input Phone!"
        assert res5.get("hasTypeSelect") == True, "Thiếu dropdown Loại hình tham gia!"
        assert res5.get("hasScanBtn") == True, "Thiếu nút quét One-Tap trên trình duyệt!"
        print("✅ TEST 5 PASS: Google Account Chooser Modal hiển thị đầy đủ và chuyên nghiệp!")

        # DỌN DẸP DỮ LIỆU TEST
        cdp.evaluate("""
            (() => {
                const data = AppStorage.loadData();
                data.users = (data.users || []).filter(u => u.email !== 'badminton.star2026@gmail.com');
                data.members = (data.members || []).filter(m => m.email !== 'badminton.star2026@gmail.com');
                AppStorage.saveData(data, false);
                App.logout();
            })()
        """)

        print("\n" + "=" * 70)
        print("TẤT CẢ 5/5 BÀI KIỂM THỬ XÁC THỰC GMAIL / GOOGLE ĐẠT 100% PASSED!")
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
