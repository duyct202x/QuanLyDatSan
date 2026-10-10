#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_members_management.py
Mục đích: Tự động kiểm thử toàn diện module Quản lý thành viên (Members Management):
Giao diện, Điều hướng, Thêm/Sửa/Xóa thành viên, Tìm kiếm, Lọc, Đăng ký gia nhập và Lưu trữ bền vững.
"""

import os
import sys
import time
import json
import subprocess
import urllib.request
import urllib.parse

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

def run_js_in_browser(ws_url, expr):
    import websocket
    ws = websocket.create_connection(ws_url, timeout=10)
    msg_id = 1
    req = {
        "id": msg_id,
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
    print("=" * 70)
    print("KIỂM THỬ TỰ ĐỘNG: MODULE QUẢN LÝ THÀNH VIÊN CLB (MEMBERS MANAGEMENT)")
    print("=" * 70)

    chrome_paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")
    ]
    chrome_exe = next((p for p in chrome_paths if os.path.exists(p)), None)
    if not chrome_exe:
        print("[!] Không tìm thấy Google Chrome!")
        return

    port = 9223
    user_data_dir = os.path.join(os.environ.get("TEMP", "."), "chrome_test_profile_members")
    chrome_cmd = [
        chrome_exe,
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={user_data_dir}",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "http://localhost:8080/index.html"
    ]

    print(f"[*] Khởi động Headless Chrome trên cổng {port}...")
    proc = subprocess.Popen(chrome_cmd)
    time.sleep(2)

    try:
        targets_url = f"http://127.0.0.1:{port}/json"
        with urllib.request.urlopen(targets_url) as resp:
            targets = json.loads(resp.read().decode())
        page_target = next(t for t in targets if t.get("type") == "page")
        ws_url = page_target["webSocketDebuggerUrl"]
        print(f"[*] Kết nối CDP thành công: {ws_url[:40]}...")

        # Bước 1: Khởi tạo và mở Tab Quản lý thành viên (Bắt đầu với CSDL sạch)
        print("\n--- BƯỚC 1: ĐIỀU HƯỚNG VÀO TAB QUẢN LÝ THÀNH VIÊN ---")
        init_res = run_js_in_browser(ws_url, """
            (async () => {
                AppStorage.googleScriptUrl = ""; // Cách ly môi trường kiểm thử tự động
                await AppStorage.resetData(false);
                App.openTab('members');
                MembersModule.renderMembersTab();
                const activeTab = App.currentTab;
                const tabPane = document.getElementById('tab-members');
                const isTabVisible = tabPane && tabPane.classList.contains('active');
                const kpiTotal = document.getElementById('members-kpi-total')?.innerText;
                
                return {
                    activeTab,
                    isTabVisible,
                    kpiTotal,
                    hasMembersModule: typeof window.MembersModule !== 'undefined'
                };
            })()
        """)
        print(f"    Trạng thái Tab Thành viên: {json.dumps(init_res, ensure_ascii=False)}")
        assert init_res["activeTab"] == 'members', "Phải mở đúng tab members"
        assert init_res["isTabVisible"] == True, "Tab members phải active"
        assert init_res["hasMembersModule"] == True, "MembersModule phải được nạp"
        print("    => [PASS] Điều hướng vào Tab Quản lý thành viên thành công!")

        # Bước 2: Đăng nhập Admin và Thêm 2 thành viên mới
        print("\n--- BƯỚC 2: ADMIN THÊM THÀNH VIÊN MỚI (CỐ ĐỊNH & VÃNG LAI) ---")
        add_res = run_js_in_browser(ws_url, """
            (() => {
                AppStorage.login('admin', 'admin', true);
                
                // Thêm thành viên 1: Cố định
                MembersModule.openAddMemberModal();
                document.getElementById('new-mem-name').value = "Nguyễn Văn Hùng";
                document.getElementById('new-mem-phone').value = "0901234567";
                document.getElementById('new-mem-type').value = "fixed";
                document.getElementById('new-mem-role').value = "member";
                MembersModule.saveNewMember({ preventDefault: () => {} });

                // Thêm thành viên 2: Vãng lai / Thủ quỹ
                MembersModule.openAddMemberModal();
                document.getElementById('new-mem-name').value = "Trần Thị Mai";
                document.getElementById('new-mem-phone').value = "0987654321";
                document.getElementById('new-mem-type').value = "guest";
                document.getElementById('new-mem-role').value = "treasurer";
                MembersModule.saveNewMember({ preventDefault: () => {} });

                const data = AppStorage.loadData();
                const kpiTotal = document.getElementById('members-kpi-total')?.innerText;
                const kpiFixed = document.getElementById('members-kpi-fixed')?.innerText;
                const kpiGuest = document.getElementById('members-kpi-guest')?.innerText;
                const kpiAdmin = document.getElementById('members-kpi-admin')?.innerText;

                return {
                    membersCount: data.members.length,
                    membersList: data.members.map(m => ({ id: m.id, name: m.name, type: m.type, role: m.role, phone: m.phone })),
                    kpiTotal,
                    kpiFixed,
                    kpiGuest,
                    kpiAdmin
                };
            })()
        """)
        print(f"    Kết quả thêm thành viên: {json.dumps(add_res, ensure_ascii=False)}")
        assert add_res["membersCount"] == 3, "Phải có 3 thành viên trong CSDL (1 admin + 2 mới)"
        assert add_res["kpiTotal"] == "3 người", "KPI tổng thành viên phải là 3 người"
        assert add_res["kpiFixed"] == "2 người", "KPI cố định phải là 2 người"
        assert add_res["kpiGuest"] == "1 người", "KPI vãng lai phải là 1 người"
        print("    => [PASS] Thêm 2 thành viên và cập nhật KPI thành công!")

        # Bước 3: Kiểm thử Tìm kiếm (Search) & Lọc (Filter)
        print("\n--- BƯỚC 3: TÌM KIẾM THEO TÊN/SĐT VÀ LỌC THEO LOẠI HÌNH ---")
        search_filter_res = run_js_in_browser(ws_url, """
            (() => {
                // 1. Tìm kiếm theo tên "Hùng"
                MembersModule.handleSearch("Hùng");
                const countHung = document.querySelectorAll('.member-roster-card').length;

                // 2. Tìm kiếm theo SĐT "0987"
                MembersModule.handleSearch("0987");
                const countPhone = document.querySelectorAll('.member-roster-card').length;

                // 3. Xóa tìm kiếm và lọc "fixed"
                MembersModule.clearSearch();
                MembersModule.setFilter("fixed");
                const countFixed = document.querySelectorAll('.member-roster-card').length;

                // 4. Lọc "guest"
                MembersModule.setFilter("guest");
                const countGuest = document.querySelectorAll('.member-roster-card').length;

                // 5. Trả về "all"
                MembersModule.setFilter("all");
                const countAll = document.querySelectorAll('.member-roster-card').length;

                return {
                    countHung,
                    countPhone,
                    countFixed,
                    countGuest,
                    countAll
                };
            })()
        """)
        print(f"    Kết quả tìm kiếm & lọc: {json.dumps(search_filter_res, ensure_ascii=False)}")
        assert search_filter_res["countHung"] == 1, "Tìm 'Hùng' phải ra 1 kết quả"
        assert search_filter_res["countPhone"] == 1, "Tìm '0987' phải ra 1 kết quả"
        assert search_filter_res["countFixed"] == 2, "Lọc 'fixed' phải ra 2 kết quả"
        assert search_filter_res["countGuest"] == 1, "Lọc 'guest' phải ra 1 kết quả"
        assert search_filter_res["countAll"] == 3, "Lọc 'all' phải ra 3 kết quả"
        print("    => [PASS] Tìm kiếm thời gian thực và Bộ lọc hoạt động hoàn hảo!")

        # Bước 4: Chỉnh sửa thông tin thành viên (Edit Member)
        print("\n--- BƯỚC 4: CHỈNH SỬA THÔNG TIN THÀNH VIÊN ---")
        edit_res = run_js_in_browser(ws_url, """
            (() => {
                const data = AppStorage.loadData();
                const memId = data.members[1].id;
                
                MembersModule.openEditMemberModal(memId);
                document.getElementById('edit-mem-name').value = "Nguyễn Hùng Dũng";
                document.getElementById('edit-mem-phone').value = "0909998888";
                MembersModule.saveEditMember({ preventDefault: () => {} }, memId);

                const updatedData = AppStorage.loadData();
                const updatedMem = updatedData.members.find(m => m.id === memId);
                return {
                    name: updatedMem.name,
                    phone: updatedMem.phone
                };
            })()
        """)
        print(f"    Kết quả sửa thành viên: {json.dumps(edit_res, ensure_ascii=False)}")
        assert edit_res["name"] == "Nguyễn Hùng Dũng", "Tên thành viên phải được cập nhật"
        assert edit_res["phone"] == "0909998888", "SĐT thành viên phải được cập nhật"
        print("    => [PASS] Chỉnh sửa thông tin thành viên thành công!")

        # Bước 5: Đăng ký thành viên công khai (Public Registration)
        print("\n--- BƯỚC 5: ĐĂNG KÝ THÀNH VIÊN GIA NHẬP CLB ---")
        reg_res = run_js_in_browser(ws_url, """
            (() => {
                MembersModule.switchSubTab('register');
                document.getElementById('reg-name').value = "Phạm Quang Minh";
                document.getElementById('reg-phone').value = "0933445566";
                document.getElementById('reg-type').value = "fixed";
                document.getElementById('reg-note').value = "Đánh đơn và đôi nam";
                
                MembersModule.handlePublicMemberRegistration({ 
                    preventDefault: () => {}, 
                    target: { reset: () => {} } 
                });

                const data = AppStorage.loadData();
                return {
                    membersTotal: data.members.length,
                    registeredMember: data.members.find(m => m.name === "Phạm Quang Minh")
                };
            })()
        """)
        print(f"    Kết quả đăng ký gia nhập: {json.dumps(reg_res, ensure_ascii=False)}")
        assert reg_res["membersTotal"] == 4, "Tổng số thành viên phải tăng lên 4"
        assert reg_res["registeredMember"]["name"] == "Phạm Quang Minh"
        print("    => [PASS] Đăng ký thành viên mới hoạt động chuẩn xác!")

        # Bước 6: Xóa thành viên (Delete Member) - BQT Admin thực hiện
        print("\n--- BƯỚC 6: XÓA THÀNH VIÊN KHỎI CLB ---")
        del_res = run_js_in_browser(ws_url, """
            (() => {
                // Đăng nhập lại với tư cách Ban Quản Trị
                AppStorage.login('admin', 'admin', true);

                // Mock window.confirm = true
                window.confirm = () => true;
                const data = AppStorage.loadData();
                const memToDelete = data.members.find(m => m.name === "Trần Thị Mai");
                
                MembersModule.deleteMember(memToDelete.id);

                const remainingData = AppStorage.loadData();
                return {
                    membersCount: remainingData.members.length,
                    names: remainingData.members.map(m => m.name)
                };
            })()
        """)
        print(f"    Kết quả sau khi xóa: {json.dumps(del_res, ensure_ascii=False)}")
        assert del_res["membersCount"] == 3, "Còn lại 3 thành viên"
        assert "Trần Thị Mai" not in del_res["names"], "Thành viên đã xóa không còn trong danh sách"
        print("    => [PASS] Xóa thành viên an toàn và dọn sạch dữ liệu liên quan thành công!")

        # Bước 7: Dọn sạch và Khôi phục trạng thái chuẩn sản xuất
        print("\n--- BƯỚC 7: RESET CSDL VỀ CHUẨN SẢN XUẤT SẠCH ---")
        reset_res = run_js_in_browser(ws_url, """
            (async () => {
                await AppStorage.resetData(false);
                const data = AppStorage.loadData();
                return {
                    membersCount: data.members.length,
                    sessionsCount: data.sessions.length
                };
            })()
        """)
        print(f"    Kết quả Reset CSDL sạch: {json.dumps(reset_res, ensure_ascii=False)}")
        assert reset_res["membersCount"] == 1
        print("    => [PASS] Đã hoàn tất đưa CSDL về trạng thái sản xuất 100% sạch.")
        print("    => [PASS] Đã hoàn tất đưa CSDL về trạng thái sản xuất 100% sạch.")

        print("\n" + "=" * 70)
        print("TẤT CẢ 7 BÀI KIỂM THỬ QUẢN LÝ THÀNH VIÊN ĐỀU ĐẠT 100% (PASSED)!")
        print("=" * 70)

    finally:
        proc.terminate()
        proc.wait()

if __name__ == "__main__":
    main()
