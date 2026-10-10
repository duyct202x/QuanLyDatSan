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
CDP_PORT = 9226
TARGET_URL = "http://localhost:8080"

def run_test():
    print("🚀 Bắt đầu kiểm thử CDP: Xác thực bảo mật tài khoản & Cơ chế chống hồi sinh tài khoản đã xóa...")
    cmd = [
        EDGE_PATH,
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        f"--user-data-dir=C:\\Users\\Dcatrus\\Documents\\Projects\\QuanLyDatSan\\scratch\\cdp_security_{int(time.time())}",
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

        # 1. Kiểm tra trạng thái đăng nhập mặc định: Phải là Guest (Khách vãng lai), KHÔNG tự ý đăng nhập bất kỳ ai
        eval1 = send("Runtime.evaluate", {
            "expression": """(() => {
                const curUser = window.AppStorage.getCurrentUser();
                const members = (window.AppStorage.loadData().members || []).map(m => m.name);
                const users = (window.AppStorage.loadData().users || []).map(u => u.username);
                return {
                    currentUser: curUser,
                    isLoggedIn: window.AppStorage.isLoggedIn(),
                    hasQuangHaiInMembers: members.some(n => n.includes('Quang Hải')),
                    hasQuangHaiInUsers: users.some(u => u.includes('0912345678') || u.includes('quanghai')),
                    membersCount: members.length
                };
            })()""",
            "returnByValue": True
        })
        def get_val(resp):
            return resp.get("result", {}).get("result", {}).get("value", resp.get("result", {}).get("value", {}))

        res1 = get_val(eval1)
        print("  1. Trạng thái khởi tạo người dùng :", "Khách vãng lai (Guest Mode) ✅" if res1.get("currentUser") is None else f"LỖI: Tự ý đăng nhập {res1.get('currentUser')}")
        print("  2. 'Nguyễn Quang Hải' trong Members:", "❌ ĐÃ XÓA SẠCH (Không còn)" if not res1.get("hasQuangHaiInMembers") else "⚠️ CÒN TỒN TẠI")
        print("  3. 'Nguyễn Quang Hải' trong Users  :", "❌ ĐÃ XÓA SẠCH (Không còn)" if not res1.get("hasQuangHaiInUsers") else "⚠️ CÒN TỒN TẠI")

        assert res1.get("currentUser") is None, "Lỗi: Không được tự ý đăng nhập người dùng khi mở trang!"
        assert not res1.get("hasQuangHaiInMembers"), "Lỗi: Nguyễn Quang Hải vẫn còn trong danh sách thành viên!"
        assert not res1.get("hasQuangHaiInUsers"), "Lỗi: Nguyễn Quang Hải vẫn còn trong danh sách tài khoản!"

        # 2. Đăng nhập Admin hợp lệ
        eval2 = send("Runtime.evaluate", {
            "expression": """(() => {
                try {
                    const data = window.AppStorage.loadData();
                    const vRes = window.AppStorage.login('admin', 'admin');
                    return {
                        users: data.users,
                        members: data.members,
                        loginRes: vRes
                    };
                } catch (e) {
                    return { error: e.toString(), stack: e.stack };
                }
            })()""",
            "returnByValue": True
        })
        res2 = get_val(eval2)
        print("  4. Đăng nhập Quản trị viên        :", "✅ THÀNH CÔNG" if res2.get("loginRes", {}).get("success") else f"❌ THẤT BẠI: {res2}")
        assert res2.get("loginRes", {}).get("success"), f"Lỗi: Đăng nhập admin thất bại! {res2}"

        # 3. Kéo dữ liệu từ Cloud (pullFromCloud) và xác nhận Nguyễn Quang Hải KHÔNG bị hồi sinh
        eval3 = send("Runtime.evaluate", {
            "expression": """(async () => {
                await window.AppStorage.pullFromCloud(false);
                const data = window.AppStorage.loadData();
                const members = (data.members || []).map(m => m.name);
                const users = (data.users || []).map(u => u.username);
                return {
                    hasQuangHaiInMembers: members.some(n => n.includes('Quang Hải')),
                    hasQuangHaiInUsers: users.some(u => u.includes('0912345678') || u.includes('quanghai')),
                    deletedMemberIds: data.deletedMemberIds || [],
                    deletedUserIds: data.deletedUserIds || []
                };
            })()""",
            "awaitPromise": True,
            "returnByValue": True
        })
        res3 = get_val(eval3)
        print("  5. Chống hồi sinh sau khi kéo Cloud:", "✅ HOÀN HẢO (Nguyễn Quang Hải không bị tái tạo)" if not res3.get("hasQuangHaiInMembers") else "❌ BỊ HỒI SINH")
        print("  6. Danh sách Tombstones bảo vệ     :", f"Members: {len(res3.get('deletedMemberIds', []))}, Users: {len(res3.get('deletedUserIds', []))}")

        assert not res3.get("hasQuangHaiInMembers"), "Lỗi: Nguyễn Quang Hải bị Cloud Sync hồi sinh!"

        # 4. Đăng xuất an toàn
        eval4 = send("Runtime.evaluate", {
            "expression": """(() => {
                window.AppStorage.logout(true);
                return {
                    currentUser: window.AppStorage.getCurrentUser(),
                    isLoggedIn: window.AppStorage.isLoggedIn()
                };
            })()""",
            "returnByValue": True
        })
        res4 = get_val(eval4)
        print("  7. Đăng xuất an toàn về Guest     :", "✅ THÀNH CÔNG (currentUser = null)" if res4.get("currentUser") is None else "❌ THẤT BẠI")
        assert res4.get("currentUser") is None, "Lỗi: Chưa đăng xuất an toàn!"

        print("\n🎉 TẤT CẢ CÁC KIỂM THỬ BẢO MẬT & CHỐNG HỒI SINH TÀI KHOẢN ĐẠT 100% PASSED!")

    finally:
        try:
            ws.close()
        except:
            pass
        proc.terminate()
        proc.wait(timeout=5)

if __name__ == '__main__':
    run_test()
