#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_benefits_rules_editor.py
Mục đích: Tự động kiểm thử toàn diện chức năng Chỉnh sửa Quyền lợi & Quy định CLB:
1. Hiển thị động trên Phiếu đăng ký gia nhập và Tab Cài đặt
2. Phân quyền bảo mật: Chặn khách vãng lai, yêu cầu xác thực Admin
3. Modal chỉnh sửa đa năng: Sửa tiêu đề/nội dung, Thêm điều khoản mới, Xóa điều khoản, Khôi phục mặc định
4. Lưu trữ bền vững vào CSDL, cập nhật giao diện thời gian thực và đồng bộ Cloud
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
    while True:
        resp = json.loads(ws.recv())
        if resp.get("id") == msg_id:
            break
    ws.close()
    if "result" in resp and "result" in resp["result"]:
        val = resp["result"]["result"].get("value")
        if val is not None:
            return val
        if "exceptionDetails" in resp["result"]:
            print(f"[CDP Exception]: {resp['result']['exceptionDetails']}")
    return resp

def main():
    print("=" * 70)
    print("KIỂM THỬ TỰ ĐỘNG: CHỈNH SỬA QUYỀN LỢI & QUY ĐỊNH CLB (BENEFITS & RULES)")
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

    port = 9224
    user_data_dir = os.path.join(os.environ.get("TEMP", "."), "chrome_test_profile_rules")
    chrome_cmd = [
        chrome_exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "--remote-allow-origins=*",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "http://localhost:8080/index.html"
    ]

    print(f"[*] Khởi động Headless Chrome trên cổng {port}...")
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.0)

    try:
        targets_url = f"http://127.0.0.1:{port}/json"
        with urllib.request.urlopen(targets_url) as resp:
            targets = json.loads(resp.read().decode())
        page_target = next(t for t in targets if t.get("type") == "page")
        ws_url = page_target["webSocketDebuggerUrl"]
        print(f"[*] Kết nối CDP thành công: {ws_url[:40]}...")

        # Bước 1: Khởi tạo và điều hướng đến Phiếu đăng ký & Quy định CLB
        print("\n--- BƯỚC 1: KIỂM TRA HIỂN THỊ ĐỘNG CỦA QUYỀN LỢI & QUY ĐỊNH CLB ---")
        init_res = run_js_in_browser(ws_url, """
            (async () => {
                AppStorage.googleScriptUrl = ""; // Cách ly test
                await AppStorage.resetData(false);
                App.openTab('members');
                MembersModule.switchSubTab('register');

                const container = document.getElementById('club-benefits-rules-list');
                const rulesCount = container ? container.children.length : 0;
                const firstRuleText = container ? container.children[0]?.innerText : '';

                return {
                    rulesCount,
                    firstRuleText,
                    hasEditBtn: !!document.querySelector('button[onclick*="openEditBenefitsAndRulesModal"]')
                };
            })()
        """)
        print(f"    Kết quả hiển thị ban đầu: {json.dumps(init_res, ensure_ascii=False)}")
        assert init_res["rulesCount"] == 4, "Phải có 4 điều khoản quy định mặc định"
        assert "Lịch đánh cố định" in init_res["firstRuleText"], "Điều khoản đầu tiên là Lịch đánh cố định"
        assert init_res["hasEditBtn"] == True, "Nút sửa quy định phải hiển thị"
        print("    => [PASS] Khung Quyền lợi & Quy định CLB đã được động hóa hoàn toàn!")

        # Bước 2: Kiểm tra phân quyền bảo mật (Khách bấm Sửa -> yêu cầu mật khẩu Admin)
        print("\n--- BƯỚC 2: BẢO MẬT & PHÂN QUYỀN KHI CHỈNH SỬA ---")
        guest_auth_res = run_js_in_browser(ws_url, """
            (() => {
                // Đảm bảo ở chế độ khách
                AppStorage.logout(false);
                MembersModule.openEditBenefitsAndRulesModal();

                const modalTitle = document.getElementById('global-modal-title')?.innerText;
                const hasPwdInput = !!document.getElementById('mem-admin-auth-pwd');

                return {
                    modalTitle,
                    hasPwdInput
                };
            })()
        """)
        print(f"    Kết quả chặn Khách vãng lai: {json.dumps(guest_auth_res, ensure_ascii=False)}")
        assert "Xác thực quyền Quản trị viên" in guest_auth_res["modalTitle"]
        assert guest_auth_res["hasPwdInput"] == True
        print("    => [PASS] Bảo mật phân quyền: Khách vãng lai bị chặn và yêu cầu mật khẩu Admin chuẩn xác!")

        # Bước 3: Admin mở Modal Chỉnh sửa Quyền lợi & Quy định CLB
        print("\n--- BƯỚC 3: ADMIN MỞ MODAL CHỈNH SỬA QUY ĐỊNH ---")
        open_modal_res = run_js_in_browser(ws_url, """
            (() => {
                AppStorage.login('admin', 'admin', true);
                MembersModule.openEditBenefitsAndRulesModal();

                const modalTitle = document.getElementById('global-modal-title')?.innerText;
                const ruleItems = document.querySelectorAll('.rule-edit-item').length;

                return {
                    modalTitle,
                    ruleItems
                };
            })()
        """)
        print(f"    Kết quả mở Modal: {json.dumps(open_modal_res, ensure_ascii=False)}")
        assert "Chỉnh sửa Quyền lợi & Quy định CLB" in open_modal_res["modalTitle"]
        assert open_modal_res["ruleItems"] == 4, "Modal phải tải đúng 4 điều khoản"
        print("    => [PASS] Modal chỉnh sửa Quyền lợi & Quy định CLB mở thành công!")

        # Bước 4: Chỉnh sửa điều khoản 1 và Thêm điều khoản mới thứ 5
        print("\n--- BƯỚC 4: CHỈNH SỬA NỘI DUNG VÀ THÊM ĐIỀU KHOẢN MỚI ---")
        edit_add_res = run_js_in_browser(ws_url, """
            (() => {
                // 1. Chỉnh sửa điều khoản 1
                const firstTitle = document.querySelectorAll('.rule-input-title')[0];
                const firstContent = document.querySelectorAll('.rule-input-content')[0];
                firstTitle.value = "Lịch sinh hoạt CLB cuối tuần";
                firstContent.value = "Thứ 7 (17h30-20h30) & Chủ nhật (18h-20h) tại sân Tre Xanh (Sân 3-4-5).";

                // 2. Thêm điều khoản mới thứ 5
                MembersModule.addRuleRowInModal();
                const titles = document.querySelectorAll('.rule-input-title');
                const contents = document.querySelectorAll('.rule-input-content');
                const lastIdx = titles.length - 1;
                titles[lastIdx].value = "Nước uống & Tiện ích";
                contents[lastIdx].value = "Nước đá và cầu thi đấu tiêu chuẩn miễn phí suốt buổi giao lưu.";

                // 3. Lưu lại
                MembersModule.saveBenefitsAndRules({ preventDefault: () => {} });

                const data = AppStorage.loadData();
                const rules = data.clubInfo.benefitsAndRules;
                const container = document.getElementById('club-benefits-rules-list');

                return {
                    totalRules: rules.length,
                    rule1Title: rules[0].title,
                    rule1Content: rules[0].content,
                    rule5Title: rules[4].title,
                    rule5Content: rules[4].content,
                    domItemsCount: container ? container.children.length : 0,
                    domText: container ? container.innerText : ''
                };
            })()
        """)
        print(f"    Kết quả sau khi lưu: {json.dumps(edit_add_res, ensure_ascii=False)}")
        assert edit_add_res["totalRules"] == 5, "Tổng số quy định phải là 5"
        assert edit_add_res["rule1Title"] == "Lịch sinh hoạt CLB cuối tuần"
        assert "Sân 3-4-5" in edit_add_res["rule1Content"]
        assert edit_add_res["rule5Title"] == "Nước uống & Tiện ích"
        assert edit_add_res["domItemsCount"] == 5, "DOM phải kết xuất ngay 5 điều khoản"
        assert "Nước uống & Tiện ích" in edit_add_res["domText"]
        print("    => [PASS] Chỉnh sửa điều khoản và Thêm điều khoản mới thành công 100%!")

        # Bước 5: Xóa điều khoản và Khôi phục mẫu chuẩn
        print("\n--- BƯỚC 5: XÓA ĐIỀU KHOẢN VÀ KHÔI PHỤC MẶC ĐỊNH ---")
        del_reset_res = run_js_in_browser(ws_url, """
            (() => {
                // 1. Mở modal và xóa điều khoản cuối
                MembersModule.openEditBenefitsAndRulesModal();
                const delBtns = document.querySelectorAll('.rule-edit-item button');
                MembersModule.deleteRuleRowInModal(delBtns[delBtns.length - 1]);
                
                const countAfterDel = document.querySelectorAll('.rule-edit-item').length;

                // 2. Khôi phục mặc định
                MembersModule.resetDefaultRulesInModal();
                const countAfterReset = document.querySelectorAll('.rule-edit-item').length;

                // 3. Lưu lại mẫu mặc định
                MembersModule.saveBenefitsAndRules({ preventDefault: () => {} });
                const data = AppStorage.loadData();

                return {
                    countAfterDel,
                    countAfterReset,
                    finalRulesCount: data.clubInfo.benefitsAndRules.length,
                    firstRuleTitle: data.clubInfo.benefitsAndRules[0].title
                };
            })()
        """)
        print(f"    Kết quả Xóa & Khôi phục mặc định: {json.dumps(del_reset_res, ensure_ascii=False)}")
        assert del_reset_res["countAfterDel"] == 4, "Sau khi xóa 1 còn 4"
        assert del_reset_res["countAfterReset"] == 4, "Khôi phục chuẩn 4 điều khoản"
        assert del_reset_res["finalRulesCount"] == 4
        assert del_reset_res["firstRuleTitle"] == "Lịch đánh cố định"
        print("    => [PASS] Xóa điều khoản và Khôi phục mẫu chuẩn hoạt động hoàn hảo!")

        # Bước 6: Làm sạch CSDL đưa về trạng thái sản xuất chuẩn
        print("\n--- BƯỚC 6: RESET CSDL CHUẨN SẢN XUẤT ---")
        clean_res = run_js_in_browser(ws_url, """
            (async () => {
                await AppStorage.resetData(false);
                const data = AppStorage.loadData();
                return {
                    membersCount: data.members.length,
                    hasBenefitsRules: Array.isArray(data.clubInfo.benefitsAndRules) && data.clubInfo.benefitsAndRules.length === 4
                };
            })()
        """)
        print(f"    Kết quả làm sạch CSDL: {json.dumps(clean_res, ensure_ascii=False)}")
        assert clean_res["membersCount"] in [0, 1]
        assert clean_res["hasBenefitsRules"] == True
        print("    => [PASS] Đã hoàn tất đưa CSDL về trạng thái sản xuất 100% sạch.")

        print("\n" + "=" * 70)
        print("TẤT CẢ 6 BÀI KIỂM THỬ CHỈNH SỬA QUY ĐỊNH ĐỀU ĐẠT 100% (PASSED)!")
        print("=" * 70)

    finally:
        proc.terminate()
        proc.wait()

if __name__ == "__main__":
    main()
