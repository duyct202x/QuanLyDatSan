#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_data_loss_prevention.py
Mục đích: Kiểm thử tự động và xác thực cơ chế Kiểm soát Bảo vệ Dữ liệu (Data Loss Prevention - DLP):
1. Thêm thành viên mới, tạo ca đặt sân, ghi giao dịch thu chi và duyệt nộp quỹ thực tế
2. Mô phỏng cập nhật phiên bản tính năng / gọi ensureDatabaseSchema nhiều lần -> Dữ liệu KHÔNG bị mất
3. Mô phỏng đồng bộ hai chiều (Smart Merge) -> Tuyệt đối KHÔNG bị đè mất ca đánh hay giao dịch
4. Kiểm tra hệ thống sao lưu tự động Rolling Backup và khả năng khôi phục an toàn
5. Tải lại trang và xác thực độ bền vững 100% của toàn bộ dữ liệu
"""

import os
import sys
import time
import json
import subprocess
import urllib.request
import http.server
import socketserver
import threading

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

SERVER_PORT = 5515
CHROME_PORT = 9230
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
    print("🛡️ KIỂM THỬ TỰ ĐỘNG: CƠ CHẾ KIỂM SOÁT & BẢO VỆ DỮ LIỆU TOÀN DIỆN (DATA PROTECTION)")
    print("=" * 80)

    server = start_local_server()
    print(f"[*] Đã khởi chạy máy chủ thử nghiệm tại http://127.0.0.1:{SERVER_PORT}")

    CHROME_EXE = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    user_data = os.path.abspath("scratch/chrome_verify_dlp")
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
    total_count = 5

    try:
        time.sleep(2)
        resp = urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json")
        targets = json.loads(resp.read().decode())
        target = next(t for t in targets if t.get("type") == "page")
        ws_url = target["webSocketDebuggerUrl"]
        print("[*] Đã kết nối Chrome CDP thành công!")

        # -------------------------------------------------------------
        # TEST 1: NẠP DỮ LIỆU THỰC TẾ (THÀNH VIÊN, LỊCH ĐÁNH, SỔ QUỸ, ĐÓNG QUỸ)
        # -------------------------------------------------------------
        print("\n--- TEST 1: NẠP DỮ LIỆU THỰC TẾ CỦA NGƯỜI DÙNG ---")
        init_res = run_js(ws_url, """
        (() => {
            const data = AppStorage.loadData();
            
            // 1. Thêm thành viên thật
            const memberId = "mem_" + Date.now();
            const newMem = {
                id: memberId,
                name: "Nguyễn Hoàng Nam",
                phone: "0912345678",
                type: "fixed",
                role: "member",
                joinDate: "2026-09-27"
            };
            data.members.push(newMem);
            
            // 2. Thêm buổi đặt sân thật
            const sessId = "ses_" + Date.now();
            const newSess = {
                id: sessId,
                title: "Giao lưu rèn luyện Chủ Nhật",
                courtName: "Sân Cầu Lông Tre Xanh",
                date: "2026-09-28",
                time: "18:00 - 20:00",
                courtNumbers: "Sân 1 & 2",
                courtPrice: 360000,
                votes: [{ memberId: memberId, status: "going", guests: 1 }]
            };
            data.sessions.push(newSess);
            
            // 3. Thêm giao dịch thu chi thật
            const txId = "tx_" + Date.now();
            const newTx = {
                id: txId,
                title: "Thu tiền quỹ tháng 9 - Nguyễn Hoàng Nam",
                type: "income",
                amount: 300000,
                category: "Quỹ tháng",
                date: "2026-09-27",
                createdAt: new Date().toISOString()
            };
            data.transactions.push(newTx);
            
            // 4. Duyệt đóng quỹ thật
            data.monthlyContributions.push({
                id: `due_2026-09_${memberId}`,
                month: "2026-09",
                memberId: memberId,
                amount: 300000,
                status: "paid",
                paidAt: new Date().toISOString(),
                method: "vietqr",
                approvedBy: "Quản trị viên CLB",
                note: "Đã chuyển khoản VietQR"
            });
            
            AppStorage.saveData(data, false);
            
            return {
                memberId: memberId,
                sessId: sessId,
                txId: txId,
                membersCount: data.members.length,
                sessionsCount: data.sessions.length,
                txCount: data.transactions.length,
                paidDuesCount: data.monthlyContributions.filter(d => d.status === 'paid').length
            };
        })()
        """)
        print(f"  + Kết quả nạp dữ liệu: {json.dumps(init_res, ensure_ascii=False)}")
        assert init_res['membersCount'] >= 2
        assert init_res['sessionsCount'] >= 1
        assert init_res['txCount'] >= 1
        assert init_res['paidDuesCount'] >= 1
        print("  => KẾT QUẢ 1: [PASS] Đã nạp thành công dữ liệu thực tế của người dùng!")
        passed_count += 1

        # -------------------------------------------------------------
        # TEST 2: MÔ PHỎNG NÂNG CẤP TÍNH NĂNG / CHẠY ensureDatabaseSchema
        # -------------------------------------------------------------
        print("\n--- TEST 2: MÔ PHỎNG NÂNG CẤP TÍNH NĂNG & GỌI ensureDatabaseSchema ---")
        upgrade_res = run_js(ws_url, """
        (() => {
            // Giả lập cập nhật version và gọi ensureDatabaseSchema nhiều lần
            AppStorage.ensureDatabaseSchema();
            AppStorage.ensureDatabaseSchema();
            
            const data = AppStorage.loadData();
            const namMember = data.members.find(m => m.name === "Nguyễn Hoàng Nam");
            const sundaySession = data.sessions.find(s => s.title.includes("Chủ Nhật"));
            const namTx = data.transactions.find(t => t.title.includes("Nguyễn Hoàng Nam"));
            const namDue = data.monthlyContributions.find(d => d.memberId === (namMember && namMember.id));
            
            return {
                hasNamMember: !!namMember,
                hasSundaySession: !!sundaySession,
                hasNamTx: !!namTx,
                hasNamDue: !!namDue,
                dueStatus: namDue ? namDue.status : null,
                membersCount: data.members.length,
                sessionsCount: data.sessions.length,
                txCount: data.transactions.length
            };
        })()
        """)
        print(f"  + Kết quả sau khi nâng cấp schema: {json.dumps(upgrade_res, ensure_ascii=False)}")
        assert upgrade_res['hasNamMember'] is True, "Thành viên người dùng tạo KHÔNG được bị mất!"
        assert upgrade_res['hasSundaySession'] is True, "Buổi đặt sân KHÔNG được bị xóa!"
        assert upgrade_res['hasNamTx'] is True, "Giao dịch sổ quỹ KHÔNG được bị xóa!"
        assert upgrade_res['hasNamDue'] is True and upgrade_res['dueStatus'] == 'paid', "Khoản đóng quỹ đã duyệt KHÔNG được bị reset về unpaid!"
        print("  => KẾT QUẢ 2: [PASS] Nâng cấp tính năng phi phá hủy - 100% dữ liệu được bảo toàn vẹn!")
        passed_count += 1

        # -------------------------------------------------------------
        # TEST 3: ĐỒNG BỘ HAI CHIỀU KHÔNG MẤT MÁT (LOSSLESS SMART MERGE)
        # -------------------------------------------------------------
        print("\n--- TEST 3: ĐỒNG BỘ HAI CHIỀU KHÔNG MẤT MÁT (LOSSLESS SMART MERGE) ---")
        merge_res = run_js(ws_url, """
        (() => {
            const localData = AppStorage.loadData();
            
            // Giả lập Cloud có thêm 1 thành viên khác từ điện thoại
            const cloudData = JSON.parse(JSON.stringify(localData));
            const phoneMemId = "mem_phone_" + Date.now();
            cloudData.members.push({
                id: phoneMemId,
                name: "Trần Bảo Ngọc (Từ điện thoại)",
                phone: "0988112233",
                type: "fixed",
                role: "member"
            });
            cloudData.lastModified = Date.now() + 1000;
            
            // Chạy Smart Merge
            const merged = AppStorage.mergeCloudWithLocal(localData, cloudData);
            AppStorage.saveData(merged, false);
            
            const hasNam = merged.members.some(m => m.name === "Nguyễn Hoàng Nam");
            const hasNgoc = merged.members.some(m => m.name === "Trần Bảo Ngọc (Từ điện thoại)");
            const hasSession = merged.sessions.some(s => s.title.includes("Chủ Nhật"));
            const hasTx = merged.transactions.some(t => t.title.includes("Nguyễn Hoàng Nam"));
            
            return {
                hasNam: hasNam,
                hasNgoc: hasNgoc,
                hasSession: hasSession,
                hasTx: hasTx,
                totalMembers: merged.members.length
            };
        })()
        """)
        print(f"  + Kết quả sau Two-Way Merge: {json.dumps(merge_res, ensure_ascii=False)}")
        assert merge_res['hasNam'] is True, "Dữ liệu máy trạm không được bị đè mất!"
        assert merge_res['hasNgoc'] is True, "Dữ liệu đám mây được tích hợp hoàn chỉnh!"
        assert merge_res['hasSession'] is True and merge_res['hasTx'] is True
        print("  => KẾT QUẢ 3: [PASS] Smart Union Merge hoạt động hoàn hảo, bảo toàn dữ liệu cả 2 nguồn!")
        passed_count += 1

        # -------------------------------------------------------------
        # TEST 4: KIỂM TRA HỆ THỐNG SAO LƯU ROLLING BACKUP VÀ TỰ ĐỘNG KHÔI PHỤC
        # -------------------------------------------------------------
        print("\n--- TEST 4: KIỂM TRA HỆ THỐNG ROLLING BACKUP & KHÔI PHỤC AN TOÀN ---")
        backup_res = run_js(ws_url, """
        (() => {
            const primaryBackupRaw = localStorage.getItem(AppStorage.BACKUP_PRIMARY_KEY);
            const historyBackupRaw = localStorage.getItem(AppStorage.BACKUP_HISTORY_KEY);
            const primary = primaryBackupRaw ? JSON.parse(primaryBackupRaw) : null;
            const history = historyBackupRaw ? JSON.parse(historyBackupRaw) : [];
            
            // Thử nghiệm khôi phục an toàn
            const restored = AppStorage.restoreFromBackup();
            
            return {
                hasPrimary: !!primary,
                primaryMembersCount: primary ? primary.membersCount : 0,
                historyCount: history.length,
                hasRestored: !!restored,
                restoredMembersCount: restored ? (restored.members || []).length : 0
            };
        })()
        """)
        print(f"  + Kết quả Rolling Backup: {json.dumps(backup_res, ensure_ascii=False)}")
        assert backup_res['hasPrimary'] is True
        assert backup_res['primaryMembersCount'] >= 3
        assert backup_res['hasRestored'] is True
        print("  => KẾT QUẢ 4: [PASS] Hệ thống Rolling Backup và Khôi phục an toàn hoạt động xuất sắc!")
        passed_count += 1

        # -------------------------------------------------------------
        # TEST 5: TẢI LẠI TRANG (F5) VÀ XÁC THỰC TÍNH BỀN VỮNG TOÀN DIỆN
        # -------------------------------------------------------------
        print("\n--- TEST 5: TẢI LẠI TRANG (F5) VÀ XÁC THỰC BẢO TOÀN DỮ LIỆU ---")
        run_js(ws_url, "location.reload()")
        time.sleep(1.5)
        
        final_check = run_js(ws_url, """
        (() => {
            const data = AppStorage.loadData();
            return {
                membersCount: (data.members || []).length,
                sessionsCount: (data.sessions || []).length,
                txCount: (data.transactions || []).length,
                hasNam: (data.members || []).some(m => m.name === "Nguyễn Hoàng Nam"),
                hasNgoc: (data.members || []).some(m => m.name === "Trần Bảo Ngọc (Từ điện thoại)"),
                hasSession: (data.sessions || []).some(s => s.title.includes("Chủ Nhật")),
                hasTx: (data.transactions || []).some(t => t.title.includes("Nguyễn Hoàng Nam")),
                paidDuesCount: (data.monthlyContributions || []).filter(d => d.status === 'paid').length
            };
        })()
        """)
        print(f"  + Sau F5 tải lại trang: {json.dumps(final_check, ensure_ascii=False)}")
        assert final_check['hasNam'] is True
        assert final_check['hasNgoc'] is True
        assert final_check['hasSession'] is True
        assert final_check['hasTx'] is True
        assert final_check['paidDuesCount'] >= 1
        print("  => KẾT QUẢ 5: [PASS] Toàn bộ dữ liệu được bảo toàn vẹn 100% sau khi tải lại trang!")
        passed_count += 1

        print("\n" + "=" * 80)
        print(f"📊 TỔNG KẾT KIỂM THỬ: ĐẠT {passed_count}/{total_count} TIÊU CHÍ (100.0%)")
        print("=" * 80)
        print("🎉 CƠ CHẾ BẢO VỆ DỮ LIỆU PHI PHÁ HỦY ĐÃ HOÀN TẤT VÀ KHẮC PHỤC TRIỆT ĐỂ LỖI MẤT DỮ LIỆU!")

    finally:
        chrome_proc.terminate()
        server.shutdown()

if __name__ == "__main__":
    main()
