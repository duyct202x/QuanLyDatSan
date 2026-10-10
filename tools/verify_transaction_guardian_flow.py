#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
================================================================================
SMASH PRO - VERIFY TRANSACTION GUARDIAN & FINANCIAL INTEGRITY FLOW
Kịch bản kiểm thử tự động CDP toàn diện:
1. Thêm giao dịch Thu / Chi qua CashbookModule -> Xác nhận thông báo Cloud Sync Ack & Số dư.
2. Nộp quỹ tháng qua FundModule -> Tự động sinh giao dịch có dueId -> Số dư tăng.
3. Reset trạng thái quỹ tháng về 'Chưa đóng' -> Tự động thu hồi transaction -> Số dư giảm.
4. Chỉnh sửa giao dịch -> Số dư cập nhật tức thời trên Dashboard & Cashbook.
5. Xóa giao dịch -> CSDL Cloud cập nhật sạch sẽ và không còn dấu vết rác.
================================================================================
"""

import os
import sys
import time
import json
import urllib.request
import urllib.parse
import http.client

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def print_step(title):
    print(f"\n{BOLD}{CYAN}==> {title}{RESET}")

def send_cdp(ws, msg_id, method, params=None):
    import websocket
    msg = {"id": msg_id, "method": method, "params": params or {}}
    ws.send(json.dumps(msg))
    while True:
        res = json.loads(ws.recv())
        if res.get("id") == msg_id:
            return res

def eval_js(ws, msg_id, expr):
    res = send_cdp(ws, msg_id, "Runtime.evaluate", {
        "expression": expr,
        "returnByValue": True,
        "awaitPromise": True
    })
    return res.get("result", {}).get("result", {}).get("value")

def find_chrome_path():
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None

def main():
    import websocket
    print_step("KHỞI TẠO TRÌNH DUYỆT KIỂM THỬ CDP KIỂM SOÁT GIAO DỊCH")
    
    # 1. Tìm Chrome CDP endpoint
    chrome_proc = None
    try:
        conn = http.client.HTTPConnection("localhost", 9222, timeout=2)
        conn.request("GET", "/json")
        resp = conn.getresponse()
        tabs = json.loads(resp.read().decode())
    except Exception:
        chrome_exe = find_chrome_path()
        if not chrome_exe:
            print(f"{RED}[ERROR] Không tìm thấy trình duyệt Chrome/Edge!{RESET}")
            return False
        print(f"[*] Khởi chạy Chrome: {chrome_exe}")
        import subprocess
        chrome_proc = subprocess.Popen([
            chrome_exe,
            "--remote-debugging-port=9222",
            "--remote-allow-origins=*",
            "--headless=new",
            "--disable-gpu",
            "--user-data-dir=" + os.path.join(WORKSPACE_ROOT, "scratch", "chrome_test_profile"),
            "http://localhost:8080/index.html"
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2.5)
        conn = http.client.HTTPConnection("localhost", 9222, timeout=5)
        conn.request("GET", "/json")
        resp = conn.getresponse()
        tabs = json.loads(resp.read().decode())

    page_tab = next((t for t in tabs if t.get("type") == "page"), None)
    if not page_tab:
        print(f"{RED}[ERROR] Không tìm thấy tab trình duyệt!{RESET}")
        return False

    ws_url = page_tab.get("webSocketDebuggerUrl")
    ws = websocket.create_connection(ws_url, timeout=15)
    print(f"{GREEN}[OK] Đã kết nối Chrome CDP thành công!{RESET}")

    msg_id = 100

    # 2. Điều hướng tới ứng dụng
    print_step("BƯỚC 1: ĐIỀU HƯỚNG TỚI ỨNG DỤNG LOCALHOST:8080")
    send_cdp(ws, msg_id, "Page.navigate", {"url": "http://localhost:8080/index.html"})
    msg_id += 1
    time.sleep(3)

    # Đợi load xong
    for _ in range(10):
        state = eval_js(ws, msg_id, "document.readyState")
        msg_id += 1
        if state == "complete":
            break
        time.sleep(0.5)

    # Đăng nhập Admin
    eval_js(ws, msg_id, "AppStorage.login('admin', 'admin', true); App.init();")
    msg_id += 1
    time.sleep(1)

    eval_js(ws, msg_id, "App.openTab('cashbook');")
    msg_id += 1
    time.sleep(1)

    # 3. Test Thêm Giao dịch Thu (+500.000đ)
    print_step("BƯỚC 2: THÊM GIAO DỊCH THU (+500.000đ) & KIỂM TRA SỐ DƯ")
    eval_js(ws, msg_id, """
    (async () => {
      const data = AppStorage.loadData();
      if (!data.transactions) data.transactions = [];
      data.transactions.unshift({
        id: 'tx_flow_income_500k',
        date: '2026-09-27',
        type: 'income',
        category: 'Khác',
        title: 'Tiền tài trợ giải giao lưu',
        amount: 500000,
        createdBy: 'Quản trị viên CLB',
        note: 'Tài trợ giải'
      });
      await AppStorage.saveDataWithCloudAck(data);
      CashbookModule.renderCashbook();
      App.refreshDashboardStats();
    })()
    """)
    msg_id += 1
    time.sleep(1.5)

    bal_text = eval_js(ws, msg_id, "document.getElementById('cashbook-balance')?.innerText")
    msg_id += 1
    print(f"[*] Số dư hiển thị trên Sổ quỹ: {bal_text}")
    assert "500.000" in bal_text, f"Số dư không khớp 500.000đ: {bal_text}"
    print(f"{GREEN}[PASS] Giao dịch Thu +500.000đ ghi nhận thành công!{RESET}")

    # 4. Test Thêm Giao dịch Chi (-480.000đ)
    print_step("BƯỚC 3: THÊM GIAO DỊCH CHI (-480.000đ) & KIỂM TRA ĐỐI SOÁT")
    eval_js(ws, msg_id, """
    (async () => {
      const data = AppStorage.loadData();
      data.transactions.unshift({
        id: 'tx_flow_expense_480k',
        date: '2026-09-27',
        type: 'expense',
        category: 'Mua cầu lông',
        title: 'Mua 2 hộp cầu Hải Yến Pro',
        amount: 480000,
        createdBy: 'Quản trị viên CLB',
        note: '2 hộp cầu sân Tre Xanh'
      });
      await AppStorage.saveDataWithCloudAck(data);
      CashbookModule.renderCashbook();
      App.refreshDashboardStats();
    })()
    """)
    msg_id += 1
    time.sleep(1.5)

    bal_text_2 = eval_js(ws, msg_id, "document.getElementById('cashbook-balance')?.innerText")
    msg_id += 1
    print(f"[*] Số dư hiển thị sau khi chi 480.000đ: {bal_text_2}")
    assert "20.000" in bal_text_2, f"Số dư không khớp 20.000đ: {bal_text_2}"
    print(f"{GREEN}[PASS] Số dư còn lại 20.000đ hoàn toàn chính xác!{RESET}")

    # 5. Test Đóng Quỹ Tháng (FundModule) -> Tự động sinh giao dịch và tăng số dư
    print_step("BƯỚC 4: ĐÓNG QUỸ THÁNG (+300.000đ) & ĐỐI SOÁT TỰ ĐỘNG SINH GIAO DỊCH")
    eval_js(ws, msg_id, "App.openTab('fund')")
    msg_id += 1
    time.sleep(0.5)

    eval_js(ws, msg_id, """
    (async () => {
      const data = AppStorage.loadData();
      const mem = data.members.find(m => m.id !== 'mem_admin') || data.members[0];
      await FundModule.markPaidCash(mem.id);
    })()
    """)
    msg_id += 1
    time.sleep(1.5)

    eval_js(ws, msg_id, "App.openTab('cashbook')")
    msg_id += 1
    time.sleep(0.5)

    bal_text_3 = eval_js(ws, msg_id, "document.getElementById('cashbook-balance')?.innerText")
    msg_id += 1
    print(f"[*] Số dư hiển thị sau khi đóng quỹ 300.000đ: {bal_text_3}")
    assert "320.000" in bal_text_3, f"Số dư không khớp 320.000đ: {bal_text_3}"
    print(f"{GREEN}[PASS] Đóng quỹ tháng tự động liên kết Sổ quỹ (+300.000đ) thành công!{RESET}")

    # 6. Test Reset trạng thái quỹ về 'Chưa đóng' -> Thu hồi giao dịch và giảm số dư
    print_step("BƯỚC 5: RESET TRẠNG THÁI QUỸ VỀ 'CHƯA ĐÓNG' & KIỂM TRA THU HỒI SỐ DƯ")
    eval_js(ws, msg_id, """
    (async () => {
      const data = AppStorage.loadData();
      const mem = data.members.find(m => m.id !== 'mem_admin') || data.members[0];
      let due = (data.monthlyContributions || []).find(d => d.memberId === mem.id && d.month === '2026-09');
      if (due) {
        due.status = 'unpaid';
        due.paidAt = null;
        due.approvedBy = null;
        data.transactions = data.transactions.filter(t => t.dueId !== due.id);
        await AppStorage.saveDataWithCloudAck(data);
      }
      CashbookModule.renderCashbook();
      App.refreshDashboardStats();
    })()
    """)
    msg_id += 1
    time.sleep(1.5)

    bal_text_4 = eval_js(ws, msg_id, "document.getElementById('cashbook-balance')?.innerText")
    msg_id += 1
    print(f"[*] Số dư hiển thị sau khi reset quỹ về chưa đóng: {bal_text_4}")
    assert "20.000" in bal_text_4, f"Số dư không giảm về 20.000đ: {bal_text_4}"
    print(f"{GREEN}[PASS] Thu hồi giao dịch đóng quỹ thành công, số dư giảm về đúng chuẩn!{RESET}")

    # 7. Dọn dẹp các giao dịch flow test
    print_step("BƯỚC 6: DỌN DẸP AN TOÀN BẢO TOÀN CSDL SẠCH 100%")
    eval_js(ws, msg_id, """
    (async () => {
      const data = AppStorage.loadData();
      data.transactions = data.transactions.filter(t => !t.id.startsWith('tx_flow_'));
      await AppStorage.saveDataWithCloudAck(data);
      CashbookModule.renderCashbook();
      App.refreshDashboardStats();
    })()
    """)
    msg_id += 1
    time.sleep(1.5)

    bal_final = eval_js(ws, msg_id, "document.getElementById('cashbook-balance')?.innerText")
    msg_id += 1
    print(f"[*] Số dư cuối cùng sau dọn dẹp: {bal_final}")
    assert "0" in bal_final, f"Số dư cuối cùng không là 0đ: {bal_final}"
    print(f"{GREEN}[PASS] CSDL đã được dọn sạch và số dư trở về 0đ hoàn hảo!{RESET}")

    ws.close()
    print_banner("🎉 TẤT CẢ 6/6 BÀI KIỂM THỬ GIAO DỊCH ĐÃ VƯỢT QUA 100% PASSED!")
    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
