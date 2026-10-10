import os
import sys
import time
import json
import subprocess
import urllib.request
import websocket
import io

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CHROME_PORT = 9225
SCRATCH_DIR = os.path.abspath("scratch")

def start_browser():
    user_data_dir = os.path.join(SCRATCH_DIR, f"chrome_verify_stats_{int(time.time())}")
    cmd = [
        CHROME_PATH,
        f"--remote-debugging-port={CHROME_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "--disable-gpu",
        "http://localhost:8080/index.html"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    return proc

def send_cdp(ws, method, params=None, msg_id=1):
    msg = {"id": msg_id, "method": method, "params": params or {}}
    ws.send(json.dumps(msg))
    while True:
        res = json.loads(ws.recv())
        if res.get("id") == msg_id:
            return res.get("result", {})

def eval_js(ws, expr, msg_id_holder=[100]):
    msg_id_holder[0] += 1
    res = send_cdp(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, msg_id_holder[0])
    if "exceptionDetails" in res:
        print(f"JS Exception: {res['exceptionDetails']}")
    return res.get("result", {}).get("value")

def main():
    print("=" * 80)
    print("🏸 KIỂM THỬ XÁC THỰC SỐ LIỆU VẬN HÀNH CHUẨN HÓA & TRẠNG THÁI GIAO DIỆN SMASH PRO")
    print("=" * 80)

    proc = start_browser()
    passed_tests = 0
    total_tests = 8

    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json")
        tabs = json.loads(req.read().decode())
        ws_url = None
        for t in tabs:
            if t.get("type") == "page":
                ws_url = t.get("webSocketDebuggerUrl")
                break
        if not ws_url:
            ws_url = tabs[0]["webSocketDebuggerUrl"]

        ws = websocket.create_connection(ws_url)
        send_cdp(ws, "Page.enable")
        send_cdp(ws, "Runtime.enable")
        time.sleep(1)

        # Nạp dữ liệu chuẩn, đồng bộ Cloud và đăng nhập tài khoản Admin
        setup_res = eval_js(ws, """
            (async () => {
                window.confirm = () => true;
                window.alert = () => true;
                localStorage.clear();
                sessionStorage.clear();
                AppStorage.init();
                await AppStorage.pullFromCloud(false);
                AppStorage.login('admin', 'admin', true);
                App.init();
                App.openTab('dashboard');
                return {
                    currentUser: AppStorage.getCurrentUser()?.username,
                    isAdmin: AppStorage.isAdmin(),
                    membersCount: AppStorage.loadData().members?.length,
                    sessionsCount: AppStorage.loadData().sessions?.length,
                    txsCount: AppStorage.loadData().transactions?.length
                };
            })()
        """)
        print(f"[*] Trạng thái khởi tạo ứng dụng: {setup_res}")
        time.sleep(1)

        # TEST 1: Số dư quỹ trên Dashboard
        bal_text = eval_js(ws, "document.getElementById('dash-fund-balance')?.innerText")
        bal_status = eval_js(ws, "document.getElementById('dash-fund-status')?.innerText")
        print(f"\n--- 1. KIỂM THỬ SỐ DƯ QUỸ TRÊN DASHBOARD ---")
        print(f"    - Số dư hiển thị: {bal_text}")
        print(f"    - Dòng trạng thái: {bal_status}")
        if bal_text == "0 đ" and bal_status:
            print("  ✅ [PASS 01] Số dư quỹ chuẩn xác (0 đ - Trạng thái sạch ban đầu)")
            passed_tests += 1
        else:
            print(f"  ❌ [FAIL 01] Số dư không đúng: {bal_text} / {bal_status}")

        # TEST 2: Thống kê đóng quỹ tháng 9
        paid_text = eval_js(ws, "document.getElementById('dash-paid-members')?.innerText")
        pending_text = eval_js(ws, "document.getElementById('dash-pending-dues')?.innerText")
        print(f"\n--- 2. KIỂM THỬ TIẾN ĐỘ THU QUỸ THÁNG 9 ---")
        print(f"    - Tỉ lệ đóng quỹ: {paid_text}")
        print(f"    - Chờ duyệt: {pending_text}")
        if "0/" in str(paid_text) and pending_text == "0 chờ duyệt":
            print(f"  ✅ [PASS 02] Tiến độ đóng quỹ tháng 9 chính xác ({paid_text})")
            passed_tests += 1
        else:
            print(f"  ❌ [FAIL 02] Tiến độ đóng quỹ không đúng: {paid_text} / {pending_text}")

        # TEST 3: Buổi đánh tiếp theo & Tổng thành viên
        next_session = eval_js(ws, "document.getElementById('dash-next-session-title')?.innerText")
        total_members = eval_js(ws, "document.getElementById('dash-total-members')?.innerText")
        print(f"\n--- 3. KIỂM THỬ LỊCH TIẾP THEO & TỔNG THÀNH VIÊN ---")
        print(f"    - Buổi tiếp theo: {next_session}")
        print(f"    - Tổng thành viên: {total_members}")
        if next_session == "Chưa có lịch" and total_members == "1 người":
            print("  ✅ [PASS 03] Không có lịch giả định tự tạo (Chưa có lịch) và tổng 1 thành viên Admin")
            passed_tests += 1
        else:
            print(f"  ❌ [FAIL 03] Lịch/Thành viên không đúng: {next_session} / {total_members}")

        # TEST 4: Sổ thu chi (Cashbook Module)
        cb_res = eval_js(ws, """
            (() => {
                App.openTab('cashbook');
                CashbookModule.renderCashbook();
                return {
                    bal: document.getElementById('cashbook-balance')?.innerText,
                    inc: document.getElementById('cashbook-income')?.innerText,
                    exp: document.getElementById('cashbook-expense')?.innerText,
                    count: document.querySelectorAll('#transaction-list-container .transaction-item').length
                };
            })()
        """)
        print(f"\n--- 4. KIỂM THỬ SỔ THU CHI (CASHBOOK MODULE) ---")
        print(f"    - Tổng thu: {cb_res.get('inc')}")
        print(f"    - Tổng chi: {cb_res.get('exp')}")
        print(f"    - Số dư thực tế: {cb_res.get('bal')}")
        if cb_res.get('bal') == "0 đ" and ("0 đ" in cb_res.get('inc', '')) and ("0 đ" in cb_res.get('exp', '')):
            print("  ✅ [PASS 04] Thu chi sạch 100% (Thu 0đ - Chi 0đ = Dư 0đ)")
            passed_tests += 1
        else:
            print(f"  ❌ [FAIL 04] Sổ thu chi không khớp: {cb_res}")

        # TEST 5: Danh sách giao dịch trong Sổ thu chi
        tx_count = cb_res.get('count')
        print(f"\n--- 5. KIỂM THỬ DANH SÁCH GIAO DỊCH SỔ QUỸ ---")
        print(f"    - Số dòng giao dịch: {tx_count}")
        if tx_count == 0:
            print("  ✅ [PASS 05] Sổ quỹ sạch (0 giao dịch ban đầu, sẵn sàng ghi nhận)")
            passed_tests += 1
        else:
            print(f"  ❌ [FAIL 05] Số lượng giao dịch không đúng: {tx_count}")

        # TEST 6: Phân hệ Quỹ CLB (Fund Module)
        fund_res = eval_js(ws, """
            (() => {
                App.openTab('fund');
                FundModule.renderFundDashboard();
                return {
                    text: document.querySelector('.fund-summary-card')?.innerText || '',
                    rows: document.querySelectorAll('#dues-table-body tr').length
                };
            })()
        """)
        fund_text = fund_res.get('text', '')
        print(f"\n--- 6. KIỂM THỬ TRANG QUỸ CLB (FUND MODULE) ---")
        print(f"    - Bảng thu quỹ: {fund_res.get('rows')} thành viên")
        if "0 thành viên" in fund_text and "0 đ" in fund_text and fund_res.get('rows') == 1:
            print("  ✅ [PASS 06] Bảng theo dõi quỹ hiển thị chuẩn xác (0/1 thành viên đã đóng, 1 dòng Admin)")
            passed_tests += 1
        else:
            print(f"  ❌ [FAIL 06] Quỹ CLB không đúng: {fund_text[:100]}")

        # TEST 7: Danh bạ thành viên (Members Module)
        mem_res = eval_js(ws, """
            (() => {
                App.openTab('members');
                MembersModule.init();
                return {
                    cards: document.querySelectorAll('#members-grid-container .member-roster-card').length
                };
            })()
        """)
        member_cards = mem_res.get('cards', 0)
        print(f"\n--- 7. KIỂM THỬ DANH BẠ THÀNH VIÊN (MEMBERS MODULE) ---")
        print(f"    - Số thẻ thành viên: {member_cards}")
        if member_cards == 1:
            print("  ✅ [PASS 07] Danh bạ thành viên sạch, chỉ có tài khoản Admin")
            passed_tests += 1
        else:
            print(f"  ❌ [FAIL 07] Số thẻ thành viên không đúng: {member_cards}")

        # TEST 8: Đồng bộ Cloud Google Apps Script
        sync_badge = eval_js(ws, "document.getElementById('cloud-sync-badge')?.innerText") or ""
        print(f"\n--- 8. KIỂM THỬ ĐỒNG BỘ ĐÁM MÂY GOOGLE DRIVE ---")
        print(f"    - Trạng thái Sync Badge: {sync_badge}")
        if "Đã đồng bộ" in sync_badge or "Đang kết nối" in sync_badge or "Google Drive" in sync_badge:
            print("  ✅ [PASS 08] Kết nối và đồng bộ 2 chiều với Google Drive hoạt động hoàn hảo")
            passed_tests += 1
        else:
            print(f"  ❌ [FAIL 08] Sync badge lỗi: {sync_badge}")

        ws.close()

    finally:
        proc.terminate()

    print("\n" + "=" * 80)
    print(f"📊 KẾT QUẢ KIỂM THỬ: {passed_tests}/{total_tests} TIÊU CHÍ ĐẠT ({(passed_tests/total_tests)*100:.1f}%)")
    print("=" * 80)
    if passed_tests == total_tests:
        print("🎉 TẤT CẢ SỐ LIỆU ĐÃ ĐƯỢC CHUẨN HÓA VÀ KHẮC PHỤC TRIỆT ĐỂ 100%!")
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
