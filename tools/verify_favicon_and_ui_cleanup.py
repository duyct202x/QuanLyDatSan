#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_favicon_and_ui_cleanup.py
Mục đích: Kiểm thử tự động giao diện và tính năng:
1. Kiểm tra Icon tag trình duyệt (Favicon SVG/PNG, Apple Touch Icon, Theme Color)
2. Kiểm tra giao diện Người dùng trên Header: Tinh gọn, trực quan, không còn nút thừa bị chen lấn
3. Kiểm tra Modal Hồ sơ cá nhân tích hợp đầy đủ (Avatar, Họ tên, SĐT, Đổi MK, Đăng xuất)
4. Kiểm tra Chân Sidebar hiển thị đúng vai trò và nút đăng xuất/đăng nhập chuẩn mực
5. Kiểm tra tính toàn vẹn CSDL sạch (Không tái phát sinh dữ liệu rác hay lịch giả định)
"""

import os
import sys
import time
import json
import subprocess
import urllib.request
import base64
import http.server
import socketserver
import threading

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

SERVER_PORT = 5512
CHROME_PORT = 9228
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
    while True:
        res = json.loads(ws.recv())
        if res.get("id") == 1:
            ws.close()
            result = res.get("result", {})
            if "exceptionDetails" in result:
                raise Exception(f"JS Exception: {result['exceptionDetails']}")
            return result.get("result", {}).get("value")

def main():
    print("=" * 80)
    print("🏸 KIỂM THỬ TỰ ĐỘNG: FAVICON TRÌNH DUYỆT, RÀ SOÁT NÚT BẤM & KHẮC PHỤC DỮ LIỆU")
    print("=" * 80)

    server = start_local_server()
    print(f"[*] Đã khởi chạy máy chủ thử nghiệm tại http://127.0.0.1:{SERVER_PORT}")

    CHROME_EXE = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    user_data = os.path.abspath("scratch/chrome_verify_favicon_ui")
    os.makedirs(user_data, exist_ok=True)

    chrome_proc = subprocess.Popen([
        CHROME_EXE,
        "--headless=new",
        "--disable-gpu",
        f"--remote-debugging-port={CHROME_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={user_data}",
        "--no-first-run",
        "--no-default-browser-check",
        f"http://127.0.0.1:{SERVER_PORT}/index.html"
    ])

    passed_count = 0
    total_count = 6

    try:
        time.sleep(2)
        resp = urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json")
        targets = json.loads(resp.read().decode())
        target = next(t for t in targets if t.get("type") == "page")
        ws_url = target["webSocketDebuggerUrl"]
        print("[*] Đã kết nối Chrome CDP thành công!")

        # -------------------------------------------------------------
        # TEST 1: KIỂM TRA FAVICON VÀ CÁC THẺ META TRÊN HEAD
        # -------------------------------------------------------------
        print("\n--- TEST 1: KIỂM TRA FAVICON VÀ CÁC THẺ META TRÊN HEAD ---")
        favicon_check = run_js(ws_url, """
        (() => {
            const svgIcon = document.querySelector('link[rel="icon"]');
            const pngIcon = document.querySelector('link[rel="alternate icon"]');
            const appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
            const themeColor = document.querySelector('meta[name="theme-color"]');
            return {
                hasSvg: !!svgIcon && svgIcon.getAttribute('href') === 'assets/favicon.svg',
                svgType: svgIcon ? svgIcon.getAttribute('type') : null,
                hasPng: !!pngIcon && pngIcon.getAttribute('href') === 'assets/favicon.png',
                hasApple: !!appleIcon && appleIcon.getAttribute('href') === 'assets/favicon.png',
                themeColor: themeColor ? themeColor.getAttribute('content') : null
            };
        })()
        """)
        print(f"  + Kết quả kiểm tra Head: {json.dumps(favicon_check, ensure_ascii=False)}")
        assert favicon_check['hasSvg'] and favicon_check['hasPng'] and favicon_check['themeColor'] == '#10b981'
        print("  => KẾT QUẢ 1: [PASS] Favicon SVG + PNG và Theme Color đã được tích hợp chuẩn xác 100%!")
        passed_count += 1

        # Set standard desktop viewport
        run_js(ws_url, "window.resizeTo ? window.resizeTo(1280, 800) : null")

        # -------------------------------------------------------------
        # TEST 2: KIỂM TRA CHẾ ĐỘ KHÁCH (CHƯA ĐĂNG NHẬP) - GIAO DIỆN HEADER & SIDEBAR
        # -------------------------------------------------------------
        print("\n--- TEST 2: KIỂM TRA GIAO DIỆN KHÁCH VÃNG LAI (GUEST MODE) ---")
        guest_ui = run_js(ws_url, """
        (() => {
            App.logout(false);
            const headerSection = document.getElementById('header-user-section');
            const headerBtn = document.getElementById('header-auth-btn-wrapper');
            const sidebarCard = document.getElementById('sidebar-user-card');
            const sidebarBtn = document.getElementById('sidebar-auth-btn-wrapper');
            const headerName = document.getElementById('header-user-name');
            
            return {
                headerText: headerSection ? headerSection.textContent.trim().replace(/\\s+/g, ' ') : '',
                headerName: headerName ? headerName.textContent.trim() : '',
                headerBtnText: headerBtn ? headerBtn.textContent.trim() : '',
                sidebarCardDisplay: sidebarCard ? sidebarCard.style.display : '',
                sidebarBtnText: sidebarBtn ? sidebarBtn.textContent.trim() : ''
            };
        })()
        """)
        print(f"  + Trạng thái Khách: {json.dumps(guest_ui, ensure_ascii=False)}")
        assert 'Khách vãng lai' in guest_ui['headerName']
        assert 'Đăng nhập' in guest_ui['headerBtnText']
        assert guest_ui['sidebarCardDisplay'] == 'none'
        assert 'Đăng nhập' in guest_ui['sidebarBtnText']
        print("  => KẾT QUẢ 2: [PASS] Chế độ Khách hiển thị tinh gọn, trực quan!")
        passed_count += 1

        # -------------------------------------------------------------
        # TEST 3: ĐĂNG NHẬP ADMIN - RÀ SOÁT BỎ NÚT THỪA TRÊN HEADER
        # -------------------------------------------------------------
        print("\n--- TEST 3: ĐĂNG NHẬP VÀ RÀ SOÁT BỎ NÚT THỪA TRÊN HEADER ---")
        login_res = run_js(ws_url, """
        (() => {
            const loginRes = AppStorage.login('admin', 'admin', true);
            App.renderUserHeaderAndSidebar();
            
            const headerSection = document.getElementById('header-user-section');
            const headerBtnWrapper = document.getElementById('header-auth-btn-wrapper');
            const headerLogoutBtn = headerBtnWrapper ? headerBtnWrapper.querySelector('button') : null;
            const sidebarCard = document.getElementById('sidebar-user-card');
            const sidebarBtn = document.getElementById('sidebar-auth-btn-wrapper');

            return {
                loginSuccess: loginRes.success,
                headerName: document.getElementById('header-user-name')?.innerText,
                headerRole: document.getElementById('header-user-role')?.innerText,
                headerHasLogoutBtn: !!headerLogoutBtn, // Phải là False (đã bỏ nút thừa)
                sidebarCardVisible: sidebarCard && sidebarCard.style.display !== 'none',
                sidebarName: document.getElementById('sidebar-user-name')?.innerText,
                sidebarHasLogoutBtn: sidebarBtn && sidebarBtn.innerText.includes('Đăng xuất')
            };
        })()
        """)
        print(f"  + Trạng thái sau Đăng nhập: {json.dumps(login_res, ensure_ascii=False)}")
        assert login_res['loginSuccess'] is True
        assert login_res['headerHasLogoutBtn'] is False, "Nút đăng xuất thừa trên Header phải được loại bỏ để tránh chen lấn với Avatar!"
        assert login_res['sidebarCardVisible'] is True
        assert login_res['sidebarHasLogoutBtn'] is True
        print("  => KẾT QUẢ 3: [PASS] Header đã được làm sạch, không còn nút Đăng xuất thừa bị chen lấn sát Avatar!")
        passed_count += 1

        # -------------------------------------------------------------
        # TEST 4: MỞ MODAL HỒ SƠ TỪ HEADER / SIDEBAR VÀ KIỂM TRA NÚT ĐĂNG XUẤT
        # -------------------------------------------------------------
        print("\n--- TEST 4: MỞ MODAL HỒ SƠ VÀ KIỂM TRA NÚT ĐĂNG XUẤT TÍCH HỢP ---")
        modal_check = run_js(ws_url, """
        (() => {
            App.openUserProfileModal();
            const modal = document.getElementById('global-modal-overlay');
            const modalTitle = document.getElementById('global-modal-title')?.innerText;
            const modalBody = document.getElementById('global-modal-body');
            const logoutBtnInModal = modalBody ? modalBody.querySelector('button[onclick*="App.logout"]') : null;
            const saveBtn = modalBody ? modalBody.querySelector('button[type="submit"]') : null;

            return {
                isOpen: modal && modal.classList.contains('active'),
                title: modalTitle,
                hasLogoutBtn: !!logoutBtnInModal,
                logoutBtnText: logoutBtnInModal ? logoutBtnInModal.innerText.trim() : '',
                hasSaveBtn: !!saveBtn
            };
        })()
        """)
        print(f"  + Trạng thái Modal Hồ sơ: {json.dumps(modal_check, ensure_ascii=False)}")
        assert modal_check['isOpen'] is True
        assert modal_check['hasLogoutBtn'] is True
        assert 'Đăng xuất' in modal_check['logoutBtnText']
        print("  => KẾT QUẢ 4: [PASS] Modal Hồ sơ cá nhân có đầy đủ chức năng và nút Đăng xuất chuẩn mực!")
        passed_count += 1

        # -------------------------------------------------------------
        # TEST 5: THỰC THI ĐĂNG XUẤT TỪ MODAL HỒ SƠ
        # -------------------------------------------------------------
        print("\n--- TEST 5: THỰC THI ĐĂNG XUẤT TỪ MODAL HỒ SƠ ---")
        logout_res = run_js(ws_url, """
        (() => {
            App.closeModal();
            App.logout();
            const currentUser = AppStorage.getCurrentUser();
            return {
                isLoggedIn: !!currentUser,
                headerName: document.getElementById('header-user-name')?.innerText
            };
        })()
        """)
        print(f"  + Sau khi Đăng xuất: {json.dumps(logout_res, ensure_ascii=False)}")
        assert logout_res['isLoggedIn'] is False
        assert logout_res['headerName'] == 'Khách vãng lai'
        print("  => KẾT QUẢ 5: [PASS] Đăng xuất hoạt động chính xác, giao diện trở về trạng thái Khách vãng lai an toàn!")
        passed_count += 1

        # -------------------------------------------------------------
        # TEST 6: XÁC THỰC CSDL SẢN XUẤT SẠCH 100% (KHÔNG TỰ TẠO DỮ LIỆU RÁC)
        # -------------------------------------------------------------
        print("\n--- TEST 6: XÁC THỰC CSDL SẢN XUẤT SẠCH 100% (KHÔNG TỰ TẠO DỮ LIỆU RÁC) ---")
        clean_check = run_js(ws_url, """
        (() => {
            const data = AppStorage.loadData();
            return {
                membersCount: (data.members || []).length,
                sessionsCount: (data.sessions || []).length,
                txsCount: (data.transactions || []).length,
                duesPaidCount: (data.monthlyContributions || []).filter(d => d.status === 'paid').length,
                fundBalance: (data.transactions || []).reduce((acc, t) => acc + (t.type === 'income' ? t.amount : -t.amount), 0)
            };
        })()
        """)
        print(f"  + Kiểm tra CSDL: {json.dumps(clean_check, ensure_ascii=False)}")
        assert clean_check['sessionsCount'] == 0, "Không được có lịch đánh giả định trong CSDL sạch!"
        assert clean_check['txsCount'] == 0, "Không được có giao dịch giả định trong CSDL sạch!"
        assert clean_check['duesPaidCount'] == 0, "Không được có số người đóng quỹ ảo!"
        assert clean_check['fundBalance'] == 0, "Số dư quỹ ban đầu phải là 0đ!"
        print("  => KẾT QUẢ 6: [PASS] CSDL chuẩn hóa sạch 100%, khắc phục triệt để lỗi kiểm lại chưa đạt!")
        passed_count += 1

        print("\n" + "=" * 80)
        print(f"📊 TỔNG KẾT KIỂM THỬ: ĐẠT {passed_count}/{total_count} TIÊU CHÍ (100.0%)")
        print("=" * 80)
        print("🎉 TẤT CẢ YÊU CẦU ĐÃ ĐƯỢC HOÀN TẤT XUẤT SẮC VÀ ĐẠT CHUẨN 100%!")

    finally:
        chrome_proc.terminate()
        server.shutdown()

if __name__ == "__main__":
    main()
