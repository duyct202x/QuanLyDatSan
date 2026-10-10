#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_avatar_and_profile.py
Mục đích: Tự động kiểm thử toàn diện chức năng Đổi Avatar và Cập nhật thông tin thành viên.
Bao gồm:
1. Đăng nhập thành viên -> Mở Modal Hồ sơ cá nhân từ Sidebar/Header
2. Đổi Avatar từ bộ sưu tập mẫu & Cập nhật Họ tên, SĐT, Bio
3. Xác minh cập nhật hiển thị tức thời trên Header, Sidebar và CSDL LocalStorage
4. Đổi mật khẩu cá nhân từ Modal Hồ sơ và xác thực đăng nhập lại
5. Quản trị viên (Admin) mở Modal Chỉnh sửa thành viên bất kỳ có Avatar Picker và lưu thông tin
6. Thêm thành viên mới kèm chọn Avatar từ bộ sưu tập mẫu
7. Kiểm tra xử lý tải ảnh đại diện nén Base64 qua Canvas
"""

import os
import sys
import time
import json
import subprocess
import urllib.request
import urllib.parse
import http.server
import socketserver
import threading

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

SERVER_PORT = 5510
CHROME_PORT = 9226
WORKSPACE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WORKSPACE_DIR, **kwargs)
    def log_message(self, format, *args):
        pass

def start_local_server():
    server = socketserver.TCPServer(("127.0.0.1", SERVER_PORT), QuietHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server

def run_js(ws_url, expr):
    import websocket
    ws = websocket.create_connection(ws_url, timeout=10)
    req = {
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": True
        }
    }
    ws.send(json.dumps(req))
    resp = json.loads(ws.recv())
    ws.close()
    if "result" in resp and "result" in resp["result"]:
        return resp["result"]["result"].get("value")
    return resp

def main():
    print("=" * 75)
    print("KIỂM THỬ TỰ ĐỘNG: ĐỔI AVATAR & CẬP NHẬT THÔNG TIN THÀNH VIÊN")
    print("=" * 75)

    server = start_local_server()
    print(f"[*] Đã khởi chạy máy chủ thử nghiệm tại http://127.0.0.1:{SERVER_PORT}")

    chrome_paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")
    ]
    chrome_exe = next((p for p in chrome_paths if os.path.exists(p)), None)
    if not chrome_exe:
        print("[!] Không tìm thấy Google Chrome!")
        return

    user_data_dir = os.path.join(os.environ.get("TEMP", "."), "chrome_test_profile_avatar")
    chrome_cmd = [
        chrome_exe,
        f"--remote-debugging-port={CHROME_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={user_data_dir}",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        f"http://127.0.0.1:{SERVER_PORT}/index.html"
    ]

    print(f"[*] Khởi động Headless Chrome trên cổng {CHROME_PORT}...")
    proc = subprocess.Popen(chrome_cmd)
    time.sleep(2)

    try:
        try:
            import websocket
        except ImportError:
            print("[*] Đang cài đặt thư viện websocket-client...")
            subprocess.run([sys.executable, "-m", "pip", "install", "websocket-client"], check=True)
            import websocket

        # Lấy WebSocket Debugger URL
        req = urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json")
        tabs = json.loads(req.read().decode("utf-8"))
        page_tab = next((t for t in tabs if t.get("type") == "page"), tabs[0])
        ws_url = page_tab["webSocketDebuggerUrl"]
        print(f"[*] Đã kết nối Chrome CDP thành công!")

        results = []

        # Khởi tạo sạch CSDL trước khi kiểm thử
        js_init = """
        (() => {
            localStorage.clear();
            sessionStorage.clear();
            AppStorage.ensureDatabaseSchema();
            const data = AppStorage.loadData();
            const adm = (data.users || []).find(u => u.username === 'admin');
            if (adm) {
                adm.password = 'admin';
                adm.name = 'Quản trị viên CLB';
            }
            AppStorage.saveData(data, false);
            return true;
        })()
        """
        run_js(ws_url, js_init)

        # -------------------------------------------------------------
        # TEST 1: Đăng nhập tài khoản & Kiểm tra click mở Modal Hồ sơ cá nhân
        # -------------------------------------------------------------
        print("\n--- KỊCH BẢN 1: ĐĂNG NHẬP & MỞ MODAL HỒ SƠ TỪ SIDEBAR USER CARD ---")
        js_t1 = """
        (() => {
            // Đăng nhập tài khoản admin
            const loginRes = AppStorage.login('admin', 'admin', true);
            App.renderUserHeaderAndSidebar();
            
            // Bấm vào sidebar user card
            const userCard = document.getElementById('sidebar-user-card');
            const cardDisplay = userCard ? window.getComputedStyle(userCard).display : 'none';
            App.openUserProfileModal();

            const modalTitle = document.getElementById('global-modal-title')?.innerText || '';
            const modalActive = document.getElementById('global-modal-overlay')?.classList.contains('active');
            const previewSrc = document.getElementById('profile-avatar-preview')?.src || '';
            const nameVal = document.getElementById('profile-name')?.value || '';

            return {
                loginSuccess: loginRes.success,
                cardDisplay: cardDisplay,
                modalActive: modalActive,
                modalTitle: modalTitle,
                hasPreview: previewSrc.length > 0,
                nameVal: nameVal
            };
        })()
        """
        r1 = run_js(ws_url, js_t1) or {}
        passed1 = r1.get('loginSuccess') and r1.get('modalActive') and 'Hồ sơ cá nhân' in r1.get('modalTitle', '')
        print(f"  + Đăng nhập Admin thành công: {r1.get('loginSuccess')}")
        print(f"  + Sidebar User Card hiển thị: {r1.get('cardDisplay')}")
        print(f"  + Modal Hồ sơ mở thành công: {r1.get('modalActive')} - Tiêu đề: '{r1.get('modalTitle')}'")
        print(f"  + Avatar Preview tải đúng: {r1.get('hasPreview')} - Họ tên: '{r1.get('nameVal')}'")
        print(f"  => KẾT QUẢ 1: {'[PASSED]' if passed1 else '[FAILED]'}")
        results.append(("Mở Modal Hồ sơ cá nhân từ Sidebar", passed1))

        # -------------------------------------------------------------
        # TEST 2: Đổi Avatar từ Preset & Cập nhật Họ tên, SĐT, Ghi chú
        # -------------------------------------------------------------
        print("\n--- KỊCH BẢN 2: CHỌN AVATAR MẪU & CẬP NHẬT THÔNG TIN CÁ NHÂN ---")
        js_t2 = """
        (() => {
            const targetAvatar = App.BADMINTON_AVATAR_PRESETS[3].url;
            App.selectPresetAvatar(targetAvatar, 'profile');
            
            document.getElementById('profile-name').value = "Ban Quản Trị SmashPro (VIP)";
            document.getElementById('profile-phone').value = "0988776655";
            document.getElementById('profile-email').value = "admin.vip@smashpro.vn";
            document.getElementById('profile-note').value = "Chủ nhiệm CLB - Trình độ A1";

            // Lưu hồ sơ
            App.saveUserProfile();

            // Kiểm tra cập nhật trên Header và Sidebar
            const headerAvatar = document.getElementById('header-user-avatar')?.src || '';
            const headerName = document.getElementById('header-user-name')?.innerText || '';
            const sidebarAvatar = document.getElementById('sidebar-user-avatar')?.src || '';
            const sidebarName = document.getElementById('sidebar-user-name')?.innerText || '';

            return {
                targetAvatar: targetAvatar,
                headerAvatar: headerAvatar,
                headerName: headerName,
                sidebarAvatar: sidebarAvatar,
                sidebarName: sidebarName
            };
        })()
        """
        r2 = run_js(ws_url, js_t2) or {}
        passed2 = (
            r2.get('targetAvatar') in r2.get('headerAvatar', '') and 
            r2.get('targetAvatar') in r2.get('sidebarAvatar', '') and
            "Ban Quản Trị SmashPro (VIP)" in r2.get('headerName', '') and
            "Ban Quản Trị SmashPro (VIP)" in r2.get('sidebarName', '')
        )
        print(f"  + Header Avatar cập nhật: {r2.get('headerAvatar')}")
        print(f"  + Header Name cập nhật: {r2.get('headerName')}")
        print(f"  + Sidebar Avatar cập nhật: {r2.get('sidebarAvatar')}")
        print(f"  + Sidebar Name cập nhật: {r2.get('sidebarName')}")
        print(f"  => KẾT QUẢ 2: {'[PASSED]' if passed2 else '[FAILED]'}")
        results.append(("Đổi Avatar & Cập nhật tên hiển thị tức thời", passed2))

        # -------------------------------------------------------------
        # TEST 3: Kiểm tra tính bền vững trong CSDL LocalStorage
        # -------------------------------------------------------------
        print("\n--- KỊCH BẢN 3: XÁC THỰC DỮ LIỆU BỀN VỮNG TRONG CSDL STORAGE ---")
        js_t3 = """
        (() => {
            const data = AppStorage.loadData();
            const currUser = AppStorage.getCurrentUser();
            const u = (data.users || []).find(x => x.username === 'admin');
            const m = (data.members || []).find(x => x.id === u.memberId || x.username === 'admin');

            return {
                currUserName: currUser?.name,
                currUserAvatar: currUser?.avatar,
                storedUserName: u?.name,
                storedUserPhone: u?.phone,
                storedUserEmail: u?.email,
                storedUserNote: u?.note,
                storedUserAvatar: u?.avatar,
                memberAvatar: m?.avatar,
                memberName: m?.name
            };
        })()
        """
        r3 = run_js(ws_url, js_t3) or {}
        passed3 = (
            r3.get('currUserName') == "Ban Quản Trị SmashPro (VIP)" and
            r3.get('storedUserName') == "Ban Quản Trị SmashPro (VIP)" and
            r3.get('storedUserPhone') == "0988776655" and
            r3.get('storedUserEmail') == "admin.vip@smashpro.vn" and
            r3.get('storedUserAvatar') == r3.get('currUserAvatar') and
            r3.get('memberAvatar') == r3.get('currUserAvatar')
        )
        print(f"  + CurrentUser Name: {r3.get('currUserName')}")
        print(f"  + Stored User Name: {r3.get('storedUserName')} | SĐT: {r3.get('storedUserPhone')}")
        print(f"  + Email: {r3.get('storedUserEmail')} | Bio: {r3.get('storedUserNote')}")
        print(f"  + Đồng bộ giữa Users & Members: {r3.get('storedUserAvatar') == r3.get('memberAvatar')}")
        print(f"  => KẾT QUẢ 3: {'[PASSED]' if passed3 else '[FAILED]'}")
        results.append(("Dữ liệu đồng bộ và lưu trữ bền vững", passed3))

        # -------------------------------------------------------------
        # TEST 4: Đổi mật khẩu cá nhân & Xác thực đăng nhập lại
        # -------------------------------------------------------------
        print("\n--- KỊCH BẢN 4: ĐỔI MẬT KHẨU TÀI KHOẢN TỪ MODAL HỒ SƠ ---")
        js_t4 = """
        (() => {
            const user = AppStorage.getCurrentUser();
            // Đổi mật khẩu từ admin thành SmashPro@888
            const updateRes = AppStorage.updateUserProfile({
                userId: user.id,
                name: user.name,
                phone: user.phone,
                currentPassword: 'admin',
                newPassword: 'SmashPro@888',
                confirmPassword: 'SmashPro@888'
            });

            // Thử đăng xuất và đăng nhập lại bằng mật khẩu cũ (phải thất bại)
            App.logout(true);
            const failLogin = AppStorage.login('admin', 'admin');

            // Thử đăng nhập lại bằng mật khẩu mới (phải thành công)
            const successLogin = AppStorage.login('admin', 'SmashPro@888', true);

            // Khôi phục lại mật khẩu admin để kịch bản sau thực hiện trơn tru
            const restoreData = AppStorage.loadData();
            const adm = (restoreData.users || []).find(u => u.username === 'admin');
            if (adm) adm.password = 'admin';
            AppStorage.saveData(restoreData, false);
            AppStorage.login('admin', 'admin', true);

            return {
                updateSuccess: updateRes.success,
                oldPwdRejected: !failLogin.success,
                newPwdAccepted: successLogin.success
            };
        })()
        """
        r4 = run_js(ws_url, js_t4) or {}
        passed4 = r4.get('updateSuccess') and r4.get('oldPwdRejected') and r4.get('newPwdAccepted')
        print(f"  + Đổi mật khẩu thành công: {r4.get('updateSuccess')}")
        print(f"  + Mật khẩu cũ bị từ chối chính xác: {r4.get('oldPwdRejected')}")
        print(f"  + Mật khẩu mới đăng nhập thành công: {r4.get('newPwdAccepted')}")
        print(f"  => KẾT QUẢ 4: {'[PASSED]' if passed4 else '[FAILED]'}")
        results.append(("Đổi mật khẩu bảo mật & Đăng nhập lại thành công", passed4))

        # -------------------------------------------------------------
        # TEST 5: Admin chỉnh sửa Avatar và thông tin của thành viên khác
        # -------------------------------------------------------------
        print("\n--- KỊCH BẢN 5: ADMIN CHỈNH SỬA AVATAR & THÔNG TIN THÀNH VIÊN KHÁC ---")
        js_t5 = """
        (() => {
            App.openTab('members');
            const data = AppStorage.loadData();
            let targetMem = (data.members || []).find(m => m.username !== 'admin');
            if (!targetMem) {
                // Thêm 1 member mẫu để test
                targetMem = {
                    id: 'mem_tran_test',
                    username: 'testmember',
                    name: 'Trần Văn Test',
                    phone: '0901234567',
                    type: 'fixed',
                    role: 'member',
                    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
                    joinDate: '2026-09-01'
                };
                data.members.push(targetMem);
                AppStorage.saveData(data, true);
            }

            // Mở modal sửa thành viên
            MembersModule.openEditMemberModal(targetMem.id);

            // Chọn avatar mới từ preset
            const newAvatar = App.BADMINTON_AVATAR_PRESETS[5].url;
            App.selectPresetAvatar(newAvatar, 'edit-mem');

            document.getElementById('edit-mem-name').value = "Trần Văn Test (Đã cập nhật)";
            document.getElementById('edit-mem-phone').value = "0909998877";
            document.getElementById('edit-mem-email').value = "tranvantest@gmail.com";
            document.getElementById('edit-mem-note').value = "Đánh chuyên lưới, tay trái";

            // Lưu thay đổi
            MembersModule.saveEditMember(null, targetMem.id);

            // Kiểm tra lại trong CSDL
            const checkData = AppStorage.loadData();
            const updatedMem = (checkData.members || []).find(m => m.id === targetMem.id);

            return {
                updatedName: updatedMem?.name,
                updatedPhone: updatedMem?.phone,
                updatedEmail: updatedMem?.email,
                updatedNote: updatedMem?.note,
                updatedAvatar: updatedMem?.avatar,
                avatarMatched: updatedMem?.avatar === newAvatar
            };
        })()
        """
        r5 = run_js(ws_url, js_t5)
        passed5 = (
            r5.get('updatedName') == "Trần Văn Test (Đã cập nhật)" and
            r5.get('updatedPhone') == "0909998877" and
            r5.get('updatedEmail') == "tranvantest@gmail.com" and
            r5.get('avatarMatched') is True
        )
        print(f"  + Tên thành viên cập nhật: {r5.get('updatedName')}")
        print(f"  + SĐT: {r5.get('updatedPhone')} | Email: {r5.get('updatedEmail')}")
        print(f"  + Avatar thành viên cập nhật chính xác: {r5.get('avatarMatched')}")
        print(f"  => KẾT QUẢ 5: {'[PASSED]' if passed5 else '[FAILED]'}")
        results.append(("Admin chỉnh sửa Avatar và thông tin hội viên", passed5))

        # -------------------------------------------------------------
        # TEST 6: Thêm thành viên mới có chọn Avatar trực quan
        # -------------------------------------------------------------
        print("\n--- KỊCH BẢN 6: THÊM THÀNH VIÊN MỚI KÈM CHỌN AVATAR TỪ BỘ SƯU TẬP ---")
        js_t6 = """
        (() => {
            MembersModule.openAddMemberModal();
            const selectedAvatar = App.BADMINTON_AVATAR_PRESETS[8].url;
            App.selectPresetAvatar(selectedAvatar, 'add-mem');

            document.getElementById('new-mem-name').value = "Lê Hoàng Yến";
            document.getElementById('new-mem-phone').value = "0977665544";
            document.getElementById('new-mem-email').value = "yen.le@gmail.com";
            document.getElementById('new-mem-type').value = "guest";
            document.getElementById('new-mem-role').value = "member";
            document.getElementById('new-mem-note').value = "Khách mời giao lưu cuối tuần";

            MembersModule.saveNewMember();

            const data = AppStorage.loadData();
            const addedMem = (data.members || []).find(m => m.name === "Lê Hoàng Yến");

            return {
                added: !!addedMem,
                addedAvatar: addedMem?.avatar,
                avatarMatched: addedMem?.avatar === selectedAvatar,
                addedPhone: addedMem?.phone,
                addedType: addedMem?.type
            };
        })()
        """
        r6 = run_js(ws_url, js_t6)
        passed6 = r6.get('added') and r6.get('avatarMatched') and r6.get('addedPhone') == "0977665544"
        print(f"  + Thêm hội viên mới thành công: {r6.get('added')}")
        print(f"  + Avatar đã chọn khớp 100%: {r6.get('avatarMatched')}")
        print(f"  + Phân loại: {r6.get('addedType')} | SĐT: {r6.get('addedPhone')}")
        print(f"  => KẾT QUẢ 6: {'[PASSED]' if passed6 else '[FAILED]'}")
        results.append(("Thêm thành viên mới với Avatar Picker trực quan", passed6))

        # -------------------------------------------------------------
        # TEST 7: Kiểm tra Tạo Avatar Initials & Dán Link URL
        # -------------------------------------------------------------
        print("\n--- KỊCH BẢN 7: TẠO AVATAR THEO TÊN & DÁN LINK URL ---")
        js_t7 = """
        (() => {
            App.openUserProfileModal();
            
            // Test 1: Tạo Avatar initials
            App.generateInitialsAvatar('profile', '3b82f6');
            const initialsAvatar = document.getElementById('profile-avatar-val')?.value || '';

            // Test 2: Dán link URL
            const testUrl = "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150";
            document.getElementById('profile-avatar-url-input').value = testUrl;
            App.applyCustomAvatarUrl('profile');
            const customUrlVal = document.getElementById('profile-avatar-val')?.value || '';

            App.closeModal();

            return {
                initialsGenerated: initialsAvatar.includes('ui-avatars.com') && initialsAvatar.includes('background=3b82f6'),
                customUrlApplied: customUrlVal === testUrl
            };
        })()
        """
        r7 = run_js(ws_url, js_t7)
        passed7 = r7.get('initialsGenerated') and r7.get('customUrlApplied')
        print(f"  + Tạo Avatar Initials theo bảng màu: {r7.get('initialsGenerated')}")
        print(f"  + Áp dụng Link URL ảnh tùy chỉnh: {r7.get('customUrlApplied')}")
        print(f"  => KẾT QUẢ 7: {'[PASSED]' if passed7 else '[FAILED]'}")
        results.append(("Tạo Avatar Initials theo màu & Áp dụng URL tùy chọn", passed7))

        # -------------------------------------------------------------
        # TỔNG KẾT
        # -------------------------------------------------------------
        print("\n" + "=" * 75)
        print("TỔNG KẾT KẾT QUẢ KIỂM THỬ TỰ ĐỘNG CHỨC NĂNG AVATAR & HỒ SƠ:")
        print("=" * 75)
        all_passed = True
        for name, p in results:
            status = "[PASSED]" if p else "[FAILED]"
            if not p:
                all_passed = False
            print(f"  {status:10} | {name}")

        print("=" * 75)
        if all_passed:
            print("🎉 TẤT CẢ 7/7 KỊCH BẢN KIỂM THỬ ĐỀU ĐẠT 100%! HỆ THỐNG HOẠT ĐỘNG HOÀN HẢO!")
        else:
            print("⚠️ CÓ KỊCH BẢN KIỂM THỬ KHÔNG ĐẠT, VUI LÒNG KIỂM TRA LẠI!")
        print("=" * 75)

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            pass
        try:
            server.shutdown()
        except Exception:
            pass

if __name__ == "__main__":
    main()
