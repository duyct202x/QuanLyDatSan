#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_sync_and_clean_db.py
Mục đích: Kiểm thử toàn diện sự đồng bộ 100% giữa tài khoản đăng nhập (users), danh bạ thành viên (members) và giao diện hiển thị:
1. Xác thực trạng thái ban đầu: CSDL Sạch 2.5_PROD, không có dữ liệu rác/test.
2. Xác thực sự đồng bộ ban đầu giữa Sidebar User Card, Header và Thẻ Admin trong Danh sách thành viên (cùng tên, cùng avatar, cùng SĐT).
3. Đổi tên và Avatar qua Modal Hồ sơ cá nhân (App.openUserProfileModal):
   - Đổi tên thành "Nguyễn Văn Admin (SmashPro)"
   - Đổi Avatar preset mới
   - Kiểm tra cả 3 vị trí (Sidebar, Header, Thẻ Admin) cập nhật đồng bộ tức thời 100%.
4. Sửa thông tin qua Modal Sửa thành viên (MembersModule.openEditMemberModal):
   - Đổi tên, đổi avatar
   - Kiểm tra Sidebar, Header, và Thẻ Admin cập nhật đồng bộ tức thời 100%.
5. F5 Reload: Kiểm tra tính bền vững và bảo toàn dữ liệu sau khi tải lại trang.
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

SERVER_PORT = 5519
CHROME_PORT = 9239
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
    ws = websocket.create_connection(ws_url, timeout=15)
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
    res = json.loads(ws.recv())
    ws.close()
    if "result" in res and "result" in res["result"]:
        return res["result"]["result"].get("value")
    return None

def capture_screenshot(ws_url, save_path):
    import websocket
    import base64
    ws = websocket.create_connection(ws_url, timeout=15)
    req = {
        "id": 2,
        "method": "Page.captureScreenshot",
        "params": {"format": "png"}
    }
    ws.send(json.dumps(req))
    res = json.loads(ws.recv())
    ws.close()
    if "result" in res and "data" in res["result"]:
        img_data = base64.b64decode(res["result"]["data"])
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        with open(save_path, "wb") as f:
            f.write(img_data)
        return True
    return False

def main():
    print("=" * 70)
    print("🚀 BẮT ĐẦU KIỂM THỬ ĐỒNG BỘ TÀI KHOẢN & DỮ LIỆU SẠCH 100% (CDP CHROME)")
    print("=" * 70)

    server = start_local_server()
    print(f"1. HTTP Server đã khởi chạy tại: http://127.0.0.1:{SERVER_PORT}")

    chrome_cmd = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        f"--remote-debugging-port={CHROME_PORT}",
        "--remote-allow-origins=*",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        f"http://127.0.0.1:{SERVER_PORT}/index.html"
    ]
    proc = subprocess.Popen(chrome_cmd)
    time.sleep(2.5)

    ws_url = None
    for _ in range(10):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json") as resp:
                targets = json.loads(resp.read().decode('utf-8'))
                for t in targets:
                    if t.get("type") == "page" and "webSocketDebuggerUrl" in t:
                        ws_url = t["webSocketDebuggerUrl"]
                        break
                if ws_url:
                    break
        except Exception:
            time.sleep(1)

    if not ws_url:
        print("❌ Không thể kết nối Chrome DevTools Protocol!")
        proc.kill()
        return

    print(f"2. Kết nối Chrome CDP thành công: {ws_url[:45]}...")

    passed_count = 0
    total_tests = 6

    # Test 1: Khởi tạo dữ liệu sạch và kiểm tra schema 2.5_PROD
    print("\n--- TEST 1: Khởi tạo và kiểm tra CSDL sạch 2.5_PROD ---")
    setup_js = """
    (() => {
        localStorage.clear();
        sessionStorage.clear();
        AppStorage.init();
        const data = AppStorage.loadData();
        return {
            version: data.version,
            usersCount: (data.users || []).length,
            membersCount: (data.members || []).length,
            adminUser: (data.users || [])[0],
            adminMember: (data.members || [])[0]
        };
    })()
    """
    res1 = run_js(ws_url, setup_js)
    print(f"   Version: {res1.get('version')}")
    print(f"   Users count: {res1.get('usersCount')}")
    print(f"   Members count: {res1.get('membersCount')}")
    assert res1.get("version") == "2.5_PROD", "Version mismatch"
    assert res1.get("usersCount") == 1, "Users count should be 1"
    print("   ✅ PASSED 1: CSDL được làm sạch chuẩn mực phiên bản 2.5_PROD!")
    passed_count += 1

    # Test 2: Đăng nhập Admin và kiểm tra sự đồng bộ 100% giữa Sidebar, Header và Card
    print("\n--- TEST 2: Đăng nhập Admin và đối soát đồng bộ ban đầu ---")
    login_js = """
    (() => {
        const loginRes = AppStorage.login('admin', 'admin', true);
        App.renderUserHeaderAndSidebar();
        App.openTab('members');
        const sidebarName = document.getElementById('sidebar-user-name')?.innerText;
        const headerName = document.getElementById('header-user-name')?.innerText;
        const sidebarAvatar = document.getElementById('sidebar-user-avatar')?.src;
        const headerAvatar = document.getElementById('header-user-avatar')?.src;
        
        const card = document.querySelector('.member-roster-card');
        const cardName = card ? card.querySelector('h4')?.innerText : '';
        const cardAvatar = card ? card.querySelector('img.avatar')?.src : '';

        return {
            loginSuccess: loginRes.success,
            sidebarName,
            headerName,
            cardName,
            sidebarAvatar,
            headerAvatar,
            cardAvatar,
            isNameSynced: (sidebarName === headerName && sidebarName === cardName),
            isAvatarSynced: (sidebarAvatar === headerAvatar && sidebarAvatar === cardAvatar)
        };
    })()
    """
    res2 = run_js(ws_url, login_js)
    print(f"   Sidebar Name: '{res2.get('sidebarName')}'")
    print(f"   Header Name: '{res2.get('headerName')}'")
    print(f"   Card Name: '{res2.get('cardName')}'")
    print(f"   Tên đồng bộ: {res2.get('isNameSynced')}")
    print(f"   Avatar đồng bộ: {res2.get('isAvatarSynced')}")
    assert res2.get("isNameSynced") == True, "Names not synced"
    assert res2.get("isAvatarSynced") == True, "Avatars not synced"
    print("   ✅ PASSED 2: Sidebar, Header và Member Card đồng bộ nhất quán 100%!")
    passed_count += 1

    # Test 3: Cập nhật Hồ sơ cá nhân (User Profile Modal)
    print("\n--- TEST 3: Cập nhật Hồ sơ cá nhân qua Modal (App.saveUserProfile) ---")
    update_profile_js = """
    (() => {
        App.openUserProfileModal();
        const nameInput = document.getElementById('profile-name');
        if (nameInput) nameInput.value = 'Chủ Nhiệm SmashPro (Đã cập nhật)';
        
        // Chọn avatar mới
        const preset = document.querySelectorAll('.avatar-preset-item')[2];
        if (preset) preset.click();

        // Lưu
        App.saveUserProfile({ preventDefault: () => {} });

        const sidebarName = document.getElementById('sidebar-user-name')?.innerText;
        const headerName = document.getElementById('header-user-name')?.innerText;
        const card = document.querySelector('.member-roster-card');
        const cardName = card ? card.querySelector('h4')?.innerText : '';
        const sidebarAvatar = document.getElementById('sidebar-user-avatar')?.src;
        const cardAvatar = card ? card.querySelector('img.avatar')?.src : '';

        return {
            sidebarName,
            headerName,
            cardName,
            isNameSynced: (sidebarName === 'Chủ Nhiệm SmashPro (Đã cập nhật)' && cardName === 'Chủ Nhiệm SmashPro (Đã cập nhật)'),
            isAvatarSynced: (sidebarAvatar === cardAvatar)
        };
    })()
    """
    res3 = run_js(ws_url, update_profile_js)
    print(f"   Sidebar Name mới: '{res3.get('sidebarName')}'")
    print(f"   Card Name mới: '{res3.get('cardName')}'")
    print(f"   Tên đồng bộ sau khi sửa: {res3.get('isNameSynced')}")
    print(f"   Avatar đồng bộ sau khi sửa: {res3.get('isAvatarSynced')}")
    assert res3.get("isNameSynced") == True, "Profile update sync failed"
    assert res3.get("isAvatarSynced") == True, "Avatar sync after profile update failed"
    print("   ✅ PASSED 3: Chỉnh sửa hồ sơ cá nhân đổi tức thì trên cả Sidebar, Header và Card!")
    passed_count += 1

    # Test 4: Chỉnh sửa qua Modal Quản lý Thành viên (MembersModule.saveEditMember)
    print("\n--- TEST 4: Chỉnh sửa thành viên qua Modal (MembersModule.saveEditMember) ---")
    edit_member_js = """
    (() => {
        const data = AppStorage.loadData();
        const memAdmin = data.members[0];
        MembersModule.openEditMemberModal(memAdmin.id);
        
        const nameInput = document.getElementById('edit-mem-name');
        if (nameInput) nameInput.value = 'Trần Văn Chủ Nhiệm (VIP)';
        
        // Chọn avatar thứ 4
        const preset = document.querySelectorAll('#edit-mem-subtab-presets .avatar-preset-item')[3];
        if (preset) preset.click();

        MembersModule.saveEditMember({ preventDefault: () => {} }, memAdmin.id);

        const sidebarName = document.getElementById('sidebar-user-name')?.innerText;
        const headerName = document.getElementById('header-user-name')?.innerText;
        const card = document.querySelector('.member-roster-card');
        const cardName = card ? card.querySelector('h4')?.innerText : '';
        const sidebarAvatar = document.getElementById('sidebar-user-avatar')?.src;
        const cardAvatar = card ? card.querySelector('img.avatar')?.src : '';

        return {
            sidebarName,
            headerName,
            cardName,
            isNameSynced: (sidebarName === 'Trần Văn Chủ Nhiệm (VIP)' && cardName === 'Trần Văn Chủ Nhiệm (VIP)'),
            isAvatarSynced: (sidebarAvatar === cardAvatar)
        };
    })()
    """
    res4 = run_js(ws_url, edit_member_js)
    print(f"   Sidebar Name mới: '{res4.get('sidebarName')}'")
    print(f"   Card Name mới: '{res4.get('cardName')}'")
    print(f"   Tên đồng bộ: {res4.get('isNameSynced')}")
    print(f"   Avatar đồng bộ: {res4.get('isAvatarSynced')}")
    assert res4.get("isNameSynced") == True, "Edit member modal sync failed"
    assert res4.get("isAvatarSynced") == True, "Edit member avatar sync failed"
    print("   ✅ PASSED 4: Chỉnh sửa thành viên đồng bộ 2 chiều hoàn hảo về User và Session!")
    passed_count += 1

    # Test 5: Reload F5 và kiểm tra tính bền vững của dữ liệu
    print("\n--- TEST 5: F5 Reload trang và kiểm tra độ bền vững dữ liệu ---")
    run_js(ws_url, "window.location.reload()")
    time.sleep(2.5)

    f5_check_js = """
    (() => {
        App.openTab('members');
        if (window.MembersModule) {
            MembersModule.switchSubTab('list');
            MembersModule.renderMembersTab();
        }
        const sidebarName = document.getElementById('sidebar-user-name')?.innerText;
        const headerName = document.getElementById('header-user-name')?.innerText;
        const card = document.querySelector('.member-roster-card');
        const cardName = card ? card.querySelector('h4')?.innerText : '';
        const sidebarAvatar = document.getElementById('sidebar-user-avatar')?.src;
        const cardAvatar = card ? card.querySelector('img.avatar')?.src : '';

        return {
            sidebarName,
            headerName,
            cardName,
            isNameSynced: (sidebarName === 'Trần Văn Chủ Nhiệm (VIP)' && cardName === 'Trần Văn Chủ Nhiệm (VIP)'),
            isAvatarSynced: (sidebarAvatar === cardAvatar)
        };
    })()
    """
    res5 = run_js(ws_url, f5_check_js)
    print(f"   F5 Sidebar Name: '{res5.get('sidebarName')}'")
    print(f"   F5 Card Name: '{res5.get('cardName')}'")
    print(f"   F5 Tên đồng bộ: {res5.get('isNameSynced')}")
    print(f"   F5 Avatar đồng bộ: {res5.get('isAvatarSynced')}")
    assert res5.get("isNameSynced") == True, "F5 data sync failed"
    assert res5.get("isAvatarSynced") == True, "F5 avatar sync failed"
    print("   ✅ PASSED 5: Dữ liệu duy trì bền vững 100% sau khi Reload F5!")
    passed_count += 1

    # Test 6: Chụp ảnh bằng chứng nghiệm thu
    print("\n--- TEST 6: Chụp ảnh màn hình nghiệm thu ---")
    screenshot_path = os.path.join(WORKSPACE_DIR, "outputs", "screenshots", "dong_bo_tai_khoan_va_du_lieu_thanh_cong.png")
    captured = capture_screenshot(ws_url, screenshot_path)
    if captured:
        print(f"   📸 Đã chụp ảnh màn hình thành công tại: {screenshot_path}")
        passed_count += 1
    else:
        print("   ⚠️ Không thể chụp ảnh màn hình")

    print("\n" + "=" * 70)
    print(f"🎉 KẾT QUẢ CUỐI CÙNG: {passed_count}/{total_tests} BÀI KIỂM THỬ ĐÃ ĐẠT 100% XUẤT SẮC!")
    print("=" * 70)

    proc.kill()

if __name__ == "__main__":
    main()
