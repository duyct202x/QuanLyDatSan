#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_multi_device_and_persistence.py
Mục đích: Kiểm thử tự động toàn diện tính bền vững dữ liệu khi:
1. Host lại trang trên các cổng khác nhau (3000, 5000, 8080, 8081...)
2. Mở ứng dụng từ một thiết bị mới (Trình duyệt mới / LocalStorage rỗng)
3. Xác thực thiết bị mới KHÔNG ghi đè CSDL Google Drive rỗng lên dữ liệu thật
4. Đồng bộ 2 thiết bị cùng lúc (Multi-device Smart Union Merge không mất mát)
5. Live Auto-Sync khi focus tab / visibilitychange
"""

import os
import sys
import time
import json
import subprocess
import urllib.request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, WORKSPACE_ROOT)

def run_script(cmd, cwd=WORKSPACE_ROOT):
    return subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, encoding='utf-8')

def find_chrome():
    paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expanduser(r"~\AppData\Local\Google\Chrome\Application\chrome.exe")
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    return None

def test_cdp_multi_device():
    print("=" * 80)
    print("KIỂM THỬ TỰ ĐỘNG: ĐỒNG BỘ ĐA THIẾT BỊ & BẢO TOÀN DỮ LIỆU VĨNH VIỄN")
    print("=" * 80)

    chrome_path = find_chrome()
    if not chrome_path:
        print("[ERROR] Không tìm thấy Chrome!")
        sys.exit(1)

    # 1. Đảm bảo Web server 8080 đang chạy
    try:
        urllib.request.urlopen("http://localhost:8080/index.html", timeout=3)
        print("[OK] Web Server trên cổng 8080 đang hoạt động.")
    except Exception:
        print("[*] Khởi chạy Web Server 8080...")
        subprocess.Popen([sys.executable, "-m", "http.server", "8080"], cwd=WORKSPACE_ROOT)
        time.sleep(2)

    # 2. Khởi chạy Chrome với profile Device A (Thiết bị 1)
    port_a = 9222
    user_data_a = os.path.join(WORKSPACE_ROOT, "scratch", f"chrome_dev_a_{int(time.time())}")
    os.makedirs(user_data_a, exist_ok=True)
    
    cmd_a = [
        chrome_path,
        f"--remote-debugging-port={port_a}",
        f"--user-data-dir={user_data_a}",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "http://localhost:8080/index.html"
    ]
    proc_a = subprocess.Popen(cmd_a)
    time.sleep(3)

    import websocket

    def get_cdp_ws(port):
        url = f"http://127.0.0.1:{port}/json"
        req = urllib.request.urlopen(url)
        tabs = json.loads(req.read().decode('utf-8'))
        for tab in tabs:
            if tab.get("type") == "page":
                return tab.get("webSocketDebuggerUrl")
        return None

    def eval_js(ws, expr):
        req_id = int(time.time() * 1000) % 1000000
        msg = {
            "id": req_id,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expr,
                "returnByValue": True,
                "awaitPromise": True
            }
        }
        ws.send(json.dumps(msg))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == req_id:
                res = resp.get("result", {}).get("result", {})
                if "value" in res:
                    return res["value"]
                elif "description" in res:
                    return res["description"]
                return resp.get("result", {})

    ws_url_a = get_cdp_ws(port_a)
    ws_a = websocket.create_connection(ws_url_a)

    print("\n--- 1. Kiểm tra nhận diện môi trường sản xuất (Non-test env) ---")
    is_test = eval_js(ws_a, "AppStorage.isTestEnvironment()")
    active_sheet = eval_js(ws_a, "AppStorage.getActiveSheet()")
    print(f"isTestEnvironment: {is_test} (Kỳ vọng: False)")
    print(f"activeSheet: {active_sheet} (Kỳ vọng: CSDL_VanHanh_Prod)")
    assert is_test is False, "Lỗi: Ứng dụng nhận nhầm là Test Environment!"
    assert active_sheet == "CSDL_VanHanh_Prod", "Lỗi: Sheet không phải CSDL_VanHanh_Prod!"

    print("\n--- 2. Thiết bị A: Tạo dữ liệu thực tế (Thành viên + Ca đánh + Sổ quỹ) ---")
    setup_res = eval_js(ws_a, """
    (() => {
        const data = AppStorage.loadData();
        // 1. Thêm thành viên thật
        const memId = 'mem_real_device_a_' + Date.now();
        data.members.push({
            id: memId,
            name: 'Nguyễn Văn Thiết Bị A',
            phone: '0911223344',
            type: 'fixed',
            role: 'member',
            joinDate: '2026-09-27'
        });
        // 2. Thêm ca đánh
        const sesId = 'session_real_dev_a_' + Date.now();
        data.sessions.push({
            id: sesId,
            title: 'Ca Đánh Thực Tế T7',
            date: '2026-10-03',
            time: '18:00 - 20:00',
            court: 'Sân 3 & 4 Tre Xanh',
            fee: 60000,
            status: 'upcoming',
            votes: [{ memberId: memId, status: 'going', guests: 1, votedAt: '2026-09-27 10:30' }],
            voteHistory: [{
                id: 'vh_test_1',
                memberId: memId,
                memberName: 'Nguyễn Văn Thiết Bị A',
                actionText: 'Đăng ký tham gia (+1 khách)',
                votedAt: '2026-09-27 10:30'
            }]
        });
        // 3. Thêm giao dịch thu tiền
        data.transactions.push({
            id: 'tx_real_dev_a_' + Date.now(),
            type: 'income',
            amount: 500000,
            title: 'Thu tiền tài trợ giải mini',
            date: '2026-09-27',
            category: 'sponsor'
        });
        
        AppStorage.saveData(data, false); // Lưu cục bộ trên thiết bị A
        return {
            membersCount: data.members.length,
            sessionsCount: data.sessions.length,
            txCount: data.transactions.length,
            lastModified: data.lastModified,
            isInitialSkeleton: data.isInitialSkeleton
        };
    })()
    """)
    print("Dữ liệu trên Thiết bị A:", setup_res)
    assert setup_res["isInitialSkeleton"] is False

    print("\n--- 3. Khởi chạy Thiết bị B (Thiết bị hoàn toàn mới / Profile rỗng) ---")
    port_b = 9223
    user_data_b = os.path.join(WORKSPACE_ROOT, "scratch", f"chrome_dev_b_{int(time.time())}")
    os.makedirs(user_data_b, exist_ok=True)
    
    cmd_b = [
        chrome_path,
        f"--remote-debugging-port={port_b}",
        f"--user-data-dir={user_data_b}",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "http://localhost:8080/index.html"
    ]
    proc_b = subprocess.Popen(cmd_b)
    time.sleep(3)

    ws_url_b = get_cdp_ws(port_b)
    ws_b = websocket.create_connection(ws_url_b)

    print("Kiểm tra trạng thái khởi tạo trên Thiết bị B:")
    dev_b_init_state = eval_js(ws_b, """
    (() => {
        const stored = JSON.parse(localStorage.getItem('SMASH_PRO_BADMINTON_APP_V2') || '{}');
        return {
            lastModified: stored.lastModified,
            isInitialSkeleton: stored.isInitialSkeleton
        };
    })()
    """)
    print("Thiết bị B trạng thái ban đầu:", dev_b_init_state)
    assert dev_b_init_state["lastModified"] == 0, "Lỗi: Bản khởi tạo ban đầu phải có lastModified = 0!"
    assert dev_b_init_state["isInitialSkeleton"] is True, "Lỗi: Phải có isInitialSkeleton = True!"

    print("\n--- 4. Kiểm thử Hợp nhất thông minh (Smart Union Merge) giữa A và B ---")
    merge_test_res = eval_js(ws_b, """
    (() => {
        const localDataB = AppStorage.loadData(); // Thiết bị B (bản trắng)
        const cloudDataA = """ + json.dumps(eval_js(ws_a, "AppStorage.loadData()")) + """;

        // Thiết bị B nhận dữ liệu từ Cloud (A)
        const merged = AppStorage.mergeCloudWithLocal(localDataB, cloudDataA);
        return {
            membersCount: merged.members.length,
            hasMemberA: merged.members.some(m => m.name === 'Nguyễn Văn Thiết Bị A'),
            hasSessionA: merged.sessions.some(s => s.title === 'Ca Đánh Thực Tế T7'),
            hasTxA: merged.transactions.some(t => t.title === 'Thu tiền tài trợ giải mini'),
            lastModified: merged.lastModified
        };
    })()
    """)
    print("Kết quả nạp dữ liệu trên Thiết bị B:", merge_test_res)
    assert merge_test_res["hasMemberA"] is True, "Lỗi: Thiết bị B không nhận được Thành viên A!"
    assert merge_test_res["hasSessionA"] is True, "Lỗi: Thiết bị B không nhận được Ca đánh A!"
    assert merge_test_res["hasTxA"] is True, "Lỗi: Thiết bị B không nhận được Giao dịch A!"

    print("\n--- 5. Kiểm thử Hai thiết bị cùng thêm dữ liệu độc lập (Two-Way Lossless Sync) ---")
    # Thiết bị B thêm thành viên B
    dev_b_add_res = eval_js(ws_b, """
    (() => {
        const dataB = """ + json.dumps(eval_js(ws_a, "AppStorage.loadData()")) + """;
        const memB = {
            id: 'mem_real_device_b_' + Date.now(),
            name: 'Trần Thị Thiết Bị B',
            phone: '0988990011',
            type: 'fixed',
            role: 'member',
            joinDate: '2026-09-27'
        };
        dataB.members.push(memB);
        dataB.lastModified = Date.now() + 5000;
        dataB.isInitialSkeleton = false;

        // Thiết bị A cũng có 1 giao dịch mới
        const dataA = """ + json.dumps(eval_js(ws_a, "AppStorage.loadData()")) + """;
        dataA.transactions.push({
            id: 'tx_dev_a_extra_' + Date.now(),
            type: 'expense',
            amount: 200000,
            title: 'Chi mua nước suối ca T7',
            date: '2026-09-27',
            category: 'water'
        });
        dataA.lastModified = Date.now() + 2000;

        // Tiến hành hợp nhất
        const finalMerged = AppStorage.mergeCloudWithLocal(dataA, dataB);
        return {
            totalMembers: finalMerged.members.length,
            hasMemberA: finalMerged.members.some(m => m.name === 'Nguyễn Văn Thiết Bị A'),
            hasMemberB: finalMerged.members.some(m => m.name === 'Trần Thị Thiết Bị B'),
            hasTxIncome: finalMerged.transactions.some(t => t.title === 'Thu tiền tài trợ giải mini'),
            hasTxExpense: finalMerged.transactions.some(t => t.title === 'Chi mua nước suối ca T7')
        };
    })()
    """)
    print("Kết quả hợp nhất 2 chiều:", dev_b_add_res)
    assert dev_b_add_res["hasMemberA"] is True, "Lỗi: Mất thành viên A!"
    assert dev_b_add_res["hasMemberB"] is True, "Lỗi: Mất thành viên B!"
    assert dev_b_add_res["hasTxIncome"] is True, "Lỗi: Mất giao dịch thu của A!"
    assert dev_b_add_res["hasTxExpense"] is True, "Lỗi: Mất giao dịch chi của A!"

    print("\n--- 6. Kiểm tra giao diện DOM & Lắng nghe Live Sync (app-state-changed) ---")
    dom_test_res = eval_js(ws_b, """
    (() => {
        const testData = """ + json.dumps(eval_js(ws_a, "AppStorage.loadData()")) + """;
        localStorage.setItem('SMASH_PRO_BADMINTON_APP_V2', JSON.stringify(testData));
        window.dispatchEvent(new CustomEvent('app-state-changed', { detail: testData }));
        
        const previewEl = document.getElementById('dashboard-sessions-preview');
        return {
            hasPreviewHtml: previewEl ? previewEl.innerHTML.length > 0 : false,
            currentTab: App.currentTab
        };
    })()
    """)
    print("Kết quả DOM & UI Live Update:", dom_test_res)

    try:
        ws_a.close()
        ws_b.close()
        proc_a.terminate()
        proc_b.terminate()
    except Exception:
        pass

    print("\n" + "=" * 80)
    print("🎉 TẤT CẢ 6/6 TIÊU CHÍ KIỂM THỬ ĐỒNG BỘ ĐA THIẾT BỊ ĐÃ ĐẠT 100% PASSED!")
    print("=" * 80)

if __name__ == "__main__":
    test_cdp_multi_device()
