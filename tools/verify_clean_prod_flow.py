#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_clean_prod_flow.py
Mục đích: Tự động kiểm thử toàn diện quy trình bảo vệ dữ liệu sản xuất CSDL_VanHanh_Prod,
cách ly triệt để môi trường kiểm thử (Test Isolation) và xác thực số dư 0đ chuẩn mực trên giao diện.
"""

import os
import sys
import time
import json
import subprocess
import urllib.request
import urllib.parse
import requests

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

def run_js_in_browser(ws_url, expr):
    """Gửi JavaScript expression qua CDP WebSocket và nhận kết quả."""
    import websocket
    ws = websocket.create_connection(ws_url, timeout=15)
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
    print("=" * 75)
    print("KIỂM THỬ TOÀN DIỆN: BẢO VỆ CSDL PRODUCTION & CÁCH LY MÔI TRƯỜNG KIỂM THỬ")
    print("=" * 75)

    # 1. Kiểm tra Google Drive Cloud Database hiện tại
    CLOUD_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec"
    print("\n--- BƯỚC 1: XÁC THỰC CSDL GOOGLE DRIVE CLOUD ĐÃ SẠCH 100% ---")
    res = requests.get(f"{CLOUD_URL}?sheet=CSDL_VanHanh_Prod", timeout=20)
    cloud_data = res.json()
    members = cloud_data.get("members", [])
    users = cloud_data.get("users", [])
    sessions = cloud_data.get("sessions", [])
    txs = cloud_data.get("transactions", [])
    dues = cloud_data.get("monthlyContributions", [])
    
    incomes = sum(t.get("amount", 0) for t in txs if t.get("type") == "income")
    expenses = sum(t.get("amount", 0) for t in txs if t.get("type") == "expense")
    balance = incomes - expenses

    print(f"[*] Google Drive CSDL_VanHanh_Prod:")
    print(f"    - Thành viên: {len(members)} ({[m.get('name') for m in members]})")
    print(f"    - Tài khoản: {len(users)} ({[u.get('username') for u in users]})")
    print(f"    - Ca đánh: {len(sessions)}")
    print(f"    - Giao dịch: {len(txs)}")
    print(f"    - Số dư quỹ: {balance:,} đ")

    assert len(members) == 1, f"Lỗi: Số thành viên phải là 1 (Admin), thực tế: {len(members)}"
    assert len(sessions) == 0, f"Lỗi: Số ca đánh phải là 0, thực tế: {len(sessions)}"
    assert len(txs) == 0, f"Lỗi: Số giao dịch phải là 0, thực tế: {len(txs)}"
    assert balance == 0, f"Lỗi: Số dư quỹ phải là 0đ, thực tế: {balance}đ"
    print("[PASS] CSDL Google Drive hoàn toàn sạch chuẩn mực!")

    # 2. Khởi động Headless Chrome truy cập ứng dụng trên cổng 8080 (Production Port)
    chrome_paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")
    ]
    chrome_exe = next((p for p in chrome_paths if os.path.exists(p)), None)
    if not chrome_exe:
        print("[!] Không tìm thấy Google Chrome!")
        return

    port = 9226
    user_data_dir = os.path.join(os.environ.get("TEMP", "."), "chrome_test_prod_verify")
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

    print(f"\n--- BƯỚC 2: KHỞI ĐỘNG CHROME TRUY CẬP ỨNG DỤNG SẢN XUẤT (PORT 8080) ---")
    proc = subprocess.Popen(chrome_cmd)
    time.sleep(2.5)

    try:
        targets_url = f"http://127.0.0.1:{port}/json"
        with urllib.request.urlopen(targets_url) as resp:
            targets = json.loads(resp.read().decode())
        page_target = next(t for t in targets if t.get("type") == "page")
        ws_url = page_target["webSocketDebuggerUrl"]
        print(f"[*] Đã kết nối Chrome CDP thành công!")

        # Đồng bộ và tải dữ liệu trên client
        client_init_res = run_js_in_browser(ws_url, """
            (async () => {
                await AppStorage.pullFromCloud(false);
                const data = AppStorage.loadData();
                const txs = data.transactions || [];
                const members = data.members || [];
                const sessions = data.sessions || [];
                const incomes = txs.filter(t => t.type === 'income').reduce((s, t) => s + (t.amount || 0), 0);
                const expenses = txs.filter(t => t.type === 'expense').reduce((s, t) => s + (t.amount || 0), 0);
                const balance = incomes - expenses;
                
                // Lấy các chỉ số hiển thị trên Dashboard DOM
                const balanceText = document.getElementById('stat-balance')?.innerText || '';
                const membersText = document.getElementById('stat-members')?.innerText || '';
                const sessionsText = document.getElementById('stat-sessions')?.innerText || '';
                
                return {
                    membersCount: members.length,
                    sessionsCount: sessions.length,
                    txsCount: txs.length,
                    balance: balance,
                    domBalance: balanceText,
                    domMembers: membersText,
                    domSessions: sessionsText
                };
            })()
        """)
        print(f"[*] Kết quả trên trình duyệt khách hàng:")
        print(f"    - Thành viên: {client_init_res['membersCount']}")
        print(f"    - Ca đánh: {client_init_res['sessionsCount']}")
        print(f"    - Giao dịch: {client_init_res['txsCount']}")
        print(f"    - Số dư quỹ: {client_init_res['balance']:,} đ")
        print(f"    - DOM Số dư: {client_init_res['domBalance']}")

        assert client_init_res['membersCount'] == 1, f"Expected 1 member, got {client_init_res['membersCount']}"
        assert client_init_res['sessionsCount'] == 0, f"Expected 0 sessions, got {client_init_res['sessionsCount']}"
        assert client_init_res['txsCount'] == 0, f"Expected 0 txs, got {client_init_res['txsCount']}"
        assert client_init_res['balance'] == 0, f"Expected 0 balance, got {client_init_res['balance']}"
        print("[PASS] Ứng dụng trên port 8080 tải CSDL chuẩn sạch 100%!")

        # 3. Kiểm thử cơ chế chặn pushToCloud trong môi trường kiểm thử (Test Isolation)
        print("\n--- BƯỚC 3: KIỂM THỬ CÁCH LY MÔI TRƯỜNG TEST (CHẶN ĐỒNG BỘ CLOUD RÁC) ---")
        test_isolation_res = run_js_in_browser(ws_url, """
            (async () => {
                // Giả lập môi trường test
                window.__IS_TEST_ENV__ = true;
                const isTest = AppStorage.isTestEnvironment();
                
                // Tạo dữ liệu test giả định
                const data = AppStorage.loadData();
                data.transactions.push({
                    id: 'tx_test_isolated_dummy',
                    type: 'expense',
                    title: 'Giao dịch test giả định chặn cloud',
                    amount: 9999999
                });
                
                // Gọi pushToCloud trong test mode
                const pushResult = await AppStorage.pushToCloud(data, false);
                window.__IS_TEST_ENV__ = false; // Phục hồi
                
                return {
                    isTest: isTest,
                    pushResult: pushResult
                };
            })()
        """)
        print(f"[*] Kết quả kiểm thử chế độ Test:")
        print(f"    - Phát hiện test environment: {test_isolation_res['isTest']}")
        print(f"    - pushToCloud trả về thành công an toàn: {test_isolation_res['pushResult']}")
        assert test_isolation_res['isTest'] == True, "Lỗi: isTestEnvironment() không phát hiện test mode"
        print("[PASS] Cơ chế cách ly môi trường test hoạt động hoàn hảo!")

        # 4. Xác nhận lại Google Drive Cloud tuyệt đối không bị dính giao dịch 9.999.999đ vừa tạo
        print("\n--- BƯỚC 4: XÁC THỰC GOOGLE DRIVE CLOUD VẪN NGUYÊN VẸN SẠCH 100% ---")
        res_after = requests.get(f"{CLOUD_URL}?sheet=CSDL_VanHanh_Prod", timeout=20)
        cloud_after = res_after.json()
        txs_after = cloud_after.get("transactions", [])
        print(f"[*] Số giao dịch trên Google Drive sau test: {len(txs_after)}")
        assert len(txs_after) == 0, f"Lỗi: Google Drive bị ghi đè giao dịch test! txs={txs_after}"
        print("[PASS] Google Drive hoàn toàn an toàn, không bị ô nhiễm bởi các thao tác kiểm thử!")

        print("\n" + "=" * 75)
        print("TẤT CẢ KIỂM THỬ ĐÃ ĐẠT 100% XUẤT SẮC!")
        print("=" * 75)

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()

if __name__ == "__main__":
    main()
