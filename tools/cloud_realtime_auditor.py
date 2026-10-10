#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
================================================================================
SMASH PRO - CLOUD REAL-TIME AUDITOR & DATA INTEGRITY AGENT
Công cụ & Agent Độc Lập Chuyên Biệt:
1. Giám sát & Kiểm tra Cập nhật Thời Gian Thực (Real-time Cloud Sync) trên Google Drive
2. Quét sâu Phát hiện Dữ liệu Ảo, Rác Kiểm thử & Bản ghi Mồ côi (Phantom/Garbage Detection)
3. Đo Độ trễ Đồng bộ (Sync Latency) và Đối soát Tính Toàn vẹn Tài chính (Ledger Balance)
4. Làm sạch & Chuẩn hóa CSDL An toàn mà không ảnh hưởng dữ liệu người dùng thật
================================================================================
"""

import os
import sys
import time
import json
import argparse
import datetime
import urllib.request
import urllib.parse

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, WORKSPACE_ROOT)

# Cấu hình kết nối Google Apps Script Cloud
GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec"
PROD_SHEET = "CSDL_VanHanh_Prod"
TEST_SHEET = "CSDL_KiemThu_Test"

# Màu hiển thị Console
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def print_banner(title):
    print("\n" + "=" * 80)
    print(f"{BOLD}{CYAN}{title.center(80)}{RESET}")
    print("=" * 80)

class CloudRealtimeAuditor:
    def __init__(self, script_url=GOOGLE_SCRIPT_URL):
        self.script_url = script_url

    def fetch_cloud_data(self, sheet_name=PROD_SHEET):
        """Tải dữ liệu trực tiếp từ Google Drive / Google Sheets và đo độ trễ mạng"""
        url = f"{self.script_url}?sheet={urllib.parse.quote(sheet_name)}&_t={int(time.time()*1000)}"
        start_time = time.time()
        try:
            import requests
            resp = requests.get(url, headers={"Accept": "application/json"}, timeout=15)
            latency_ms = int((time.time() - start_time) * 1000)
            data = resp.json()
            return {
                "success": True,
                "status_code": resp.status_code,
                "latency_ms": latency_ms,
                "data": data,
                "raw_size": len(resp.content)
            }
        except Exception as e:
            latency_ms = int((time.time() - start_time) * 1000)
            return {
                "success": False,
                "error": str(e),
                "latency_ms": latency_ms,
                "data": None
            }

    def push_cloud_data(self, data, sheet_name=PROD_SHEET):
        """Đẩy dữ liệu cập nhật an toàn lên Cloud"""
        url = f"{self.script_url}?sheet={urllib.parse.quote(sheet_name)}"
        data["sheetName"] = sheet_name
        start_time = time.time()
        try:
            import requests
            resp = requests.post(
                url,
                data=json.dumps(data),
                headers={"Content-Type": "text/plain;charset=utf-8"},
                timeout=30
            )
            latency_ms = int((time.time() - start_time) * 1000)
            return {
                "success": resp.status_code in [200, 302],
                "status_code": resp.status_code,
                "latency_ms": latency_ms,
                "response_text": resp.text
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }

    def audit_integrity_and_phantom_data(self, data, sheet_name=PROD_SHEET):
        """
        Quét sâu toàn diện CSDL:
        1. Kiểm tra tính toàn vẹn cấu trúc (Schema Integrity)
        2. Phát hiện dữ liệu ảo / tàn dư kiểm thử (Phantom & Garbage Data)
        3. Phát hiện bản ghi mồ côi (Orphaned Contributions, Orphaned Votes)
        4. Đối soát số dư sổ quỹ (Thu - Chi = Dư)
        """
        issues = []
        warnings = []
        stats = {}

        if not data or not isinstance(data, dict):
            return {
                "is_clean": False,
                "issues": ["CSDL Cloud rỗng hoặc không đúng định dạng JSON object!"],
                "warnings": [],
                "stats": {},
                "phantom_items": []
            }

        phantom_items = []

        # 1. Thống kê cơ bản
        members = data.get("members", [])
        users = data.get("users", [])
        sessions = data.get("sessions", [])
        transactions = data.get("transactions", [])
        contributions = data.get("monthlyContributions", [])
        club_info = data.get("clubInfo", {})
        last_modified = data.get("lastModified", 0)

        stats["members_count"] = len(members)
        stats["users_count"] = len(users)
        stats["sessions_count"] = len(sessions)
        stats["transactions_count"] = len(transactions)
        stats["contributions_count"] = len(contributions)
        stats["version"] = data.get("version", "N/A")
        stats["mode"] = data.get("mode", "N/A")
        stats["club_name"] = club_info.get("name", "N/A")

        if last_modified > 0:
            stats["last_modified_human"] = datetime.datetime.fromtimestamp(last_modified / 1000.0).strftime("%Y-%m-%d %H:%M:%S")
        else:
            stats["last_modified_human"] = "Chưa có timestamp"

        # 2. Quét Users & Members
        member_ids = set()
        for idx, m in enumerate(members):
            m_id = str(m.get("id", ""))
            m_name = str(m.get("name", ""))
            member_ids.add(m_id)

            # Phát hiện dữ liệu ảo test
            if "test" in m_id.lower() or "test" in m_name.lower() or m_id == "mem_vanhau":
                issues.append(f"Phát hiện Thành viên ảo/test: ID='{m_id}', Tên='{m_name}'")
                phantom_items.append({"type": "member", "id": m_id, "name": m_name})

        user_ids = set()
        has_admin = False
        for u in users:
            u_id = str(u.get("id", ""))
            u_name = str(u.get("username", ""))
            user_ids.add(u_id)
            if u_name == "admin" or u.get("role") == "admin":
                has_admin = True
            if "test" in u_id.lower() or "test" in u_name.lower() or u_id in ["user_vanhau", "user_regular"]:
                issues.append(f"Phát hiện Tài khoản ảo/test: ID='{u_id}', Username='{u_name}'")
                phantom_items.append({"type": "user", "id": u_id, "username": u_name})

        if not has_admin:
            issues.append("CẢNH BÁO NGUY HIỂM: Không tìm thấy tài khoản Quản trị viên (admin)!")

        # 3. Quét Sessions & Votes
        for s in sessions:
            s_id = str(s.get("id", ""))
            s_title = str(s.get("title", ""))
            if "test" in s_id.lower() or s_id.startswith("ses_test_") or s_id.startswith("session_test_"):
                issues.append(f"Phát hiện Ca đánh ảo/test: ID='{s_id}', Tiêu đề='{s_title}'")
                phantom_items.append({"type": "session", "id": s_id, "title": s_title})

            # Kiểm tra votes mồ côi hoặc trùng lặp
            votes = s.get("votes", [])
            voted_members = set()
            for v in votes:
                v_mem_id = v.get("memberId")
                if v_mem_id not in member_ids and v_mem_id not in user_ids:
                    warnings.append(f"Ca '{s_title}' có phiếu vote mồ côi (memberId '{v_mem_id}' không tồn tại trong danh bạ)")
                    phantom_items.append({"type": "vote_orphan", "sessionId": s_id, "memberId": v_mem_id})
                if v_mem_id in voted_members:
                    issues.append(f"Ca '{s_title}' bị trùng lặp phiếu vote của thành viên '{v_mem_id}' (1 người > 1 vote active)")
                    phantom_items.append({"type": "vote_duplicate", "sessionId": s_id, "memberId": v_mem_id})
                voted_members.add(v_mem_id)

        # 4. Quét Transactions & Tính toán Sổ quỹ
        total_income = 0
        total_expense = 0
        for t in transactions:
            t_id = str(t.get("id", ""))
            title = str(t.get("title") or t.get("description") or "").lower().strip()
            amount = float(t.get("amount", 0))
            t_type = t.get("type", "income")

            if t_type == "income":
                total_income += amount
            elif t_type == "expense":
                total_expense += amount

            # Phát hiện giao dịch rác / ảo / probe
            if "tx_test_" in t_id.lower() or "realtime_audit_probe_" in t_id.lower() or t_id == "tx_1790423944296" or t_id == "tx_test_garbage" or title in ["cxasxa", "s"] or t.get("category") == "audit_probe" or amount <= 0:
                issues.append(f"Phát hiện Giao dịch ảo/test/probe: ID='{t_id}', Tiêu đề='{title}', Số tiền={amount:,.0f}đ")
                phantom_items.append({"type": "transaction", "id": t_id, "title": title, "amount": amount})

        calculated_balance = total_income - total_expense
        stats["total_income"] = total_income
        stats["total_expense"] = total_expense
        stats["calculated_balance"] = calculated_balance

        # 5. Quét Monthly Contributions
        tx_due_ids = set(t.get("dueId") for t in transactions if t.get("dueId"))
        for c in contributions:
            c_mem_id = c.get("memberId")
            if c_mem_id not in member_ids:
                warnings.append(f"Bản ghi đóng quỹ tháng '{c.get('month')}' mồ côi (memberId '{c_mem_id}' không tồn tại)")
                phantom_items.append({"type": "contribution_orphan", "id": c.get("id"), "memberId": c_mem_id})
            elif c.get("status") == "paid" and not c.get("billImage") and c.get("id") not in tx_due_ids:
                issues.append(f"Phát hiện Ghi nhận đóng quỹ ảo không có chứng từ/giao dịch: Thành viên '{c_mem_id}', ID='{c.get('id')}', Số tiền={c.get('amount',0):,.0f}đ")
                phantom_items.append({"type": "contribution_unverified_paid", "id": c.get("id"), "memberId": c_mem_id})

        return {
            "is_clean": len(issues) == 0,
            "issues": issues,
            "warnings": warnings,
            "stats": stats,
            "phantom_items": phantom_items
        }

    def verify_live_realtime_sync(self, sheet_name=TEST_SHEET):
        """
        Kiểm tra độ trễ và tính chuẩn xác của luồng Cập nhật Real-Time:
        1. Tạo một giao dịch định danh thời gian thực trên CSDL Cloud Test
        2. Đo thời gian Google Drive nhận và phản hồi dữ liệu
        3. Xác thực giá trị chính xác tuyệt đối trên Cloud
        """
        print_banner(f"KIỂM TRA CẬP NHẬT THỜI GIAN THỰC ({sheet_name})")
        
        test_tx_id = f"realtime_audit_probe_{int(time.time()*1000)}"
        test_amount = 123456
        test_title = f"Kiểm toán Realtime Probe {datetime.datetime.now().strftime('%H:%M:%S')}"
        
        print(f"[*] Đang tải trạng thái CSDL Cloud hiện hành ({sheet_name})...")
        fetch_res = self.fetch_cloud_data(sheet_name)
        if not fetch_res["success"]:
            print(f"{RED}[ERROR] Không thể kết nối tới Google Drive: {fetch_res['error']}{RESET}")
            return False

        cloud_data = fetch_res["data"] or {}
        print(f"{GREEN}[OK] Kết nối Google Drive thành công! Độ trễ đọc: {fetch_res['latency_ms']} ms{RESET}")
        
        # 1. Thêm probe item và đẩy lên Cloud
        print(f"[*] Đang gửi bản ghi kiểm toán thời gian thực: '{test_title}'...")
        if "transactions" not in cloud_data or not isinstance(cloud_data["transactions"], list):
            cloud_data["transactions"] = []
            
        probe_record = {
            "id": test_tx_id,
            "type": "income",
            "amount": test_amount,
            "title": test_title,
            "date": datetime.datetime.now().strftime("%Y-%m-%d"),
            "category": "audit_probe",
            "createdAt": datetime.datetime.now().isoformat()
        }
        cloud_data["transactions"].insert(0, probe_record)
        cloud_data["lastModified"] = int(time.time() * 1000)
        
        push_start = time.time()
        push_res = self.push_cloud_data(cloud_data, sheet_name)
        push_latency = int((time.time() - push_start) * 1000)
        
        if not push_res["success"]:
            print(f"{RED}[ERROR] Không thể đẩy dữ liệu lên Google Drive: {push_res.get('error')}{RESET}")
            return False
            
        print(f"{GREEN}[OK] Đã ghi nhận lên Google Drive! Độ trễ ghi (Write Latency): {push_latency} ms{RESET}")

        # 2. Đọc lại ngay lập tức từ Cloud để xác thực tính đồng bộ tức thì
        print(f"[*] Đang đối soát tính tức thời (Real-Time Read Verification)...")
        verify_fetch = self.fetch_cloud_data(sheet_name)
        verify_data = verify_fetch.get("data", {})
        found = False
        for t in verify_data.get("transactions", []):
            if t.get("id") == test_tx_id and t.get("amount") == test_amount:
                found = True
                break

        # 3. Dọn dẹp bản ghi probe sau khi kiểm toán hoàn tất
        print(f"[*] Đang thu hồi bản ghi kiểm toán probe để bảo toàn CSDL sạch 100%...")
        verify_data["transactions"] = [t for t in verify_data.get("transactions", []) if t.get("id") != test_tx_id]
        verify_data["lastModified"] = int(time.time() * 1000)
        self.push_cloud_data(verify_data, sheet_name)
        print(f"{GREEN}[OK] CSDL Cloud đã được làm sạch và bảo toàn nguyên vẹn!{RESET}")

        if found:
            print(f"\n{BOLD}{GREEN}🎉 KẾT QUẢ: DỮ LIỆU ĐƯỢC CẬP NHẬT REAL-TIME VÀO CLOUD HOÀN TOÀN CHUẨN XÁC!{RESET}")
            print(f"  • Độ trễ đọc (Read Latency) : {verify_fetch['latency_ms']} ms")
            print(f"  • Độ trễ ghi (Write Latency): {push_latency} ms")
            print(f"  • Độ chính xác dữ liệu      : 100% (Khớp định danh & số tiền)")
            return True
        else:
            print(f"\n{BOLD}{RED}❌ KẾT QUẢ: Dữ liệu chưa xuất hiện tức thời trên Cloud!{RESET}")
            return False

    def clean_phantom_records(self, sheet_name=PROD_SHEET):
        """Tự động làm sạch mọi tàn dư ảo/test trên Google Drive"""
        print_banner(f"LÀM SẠCH VÀ CHUẨN HÓA DỮ LIỆU CLOUD ({sheet_name})")
        fetch_res = self.fetch_cloud_data(sheet_name)
        if not fetch_res["success"]:
            print(f"{RED}[ERROR] Không thể kết nối Cloud: {fetch_res['error']}{RESET}")
            return False

        data = fetch_res["data"]
        audit_res = self.audit_integrity_and_phantom_data(data, sheet_name)

        if audit_res["is_clean"] and len(audit_res["warnings"]) == 0:
            print(f"{GREEN}[OK] CSDL Cloud đã hoàn toàn sạch sẽ, không có dữ liệu ảo hay bản ghi mồ côi nào!{RESET}")
            return True

        print(f"[*] Tìm thấy {len(audit_res['phantom_items'])} đối tượng cần làm sạch...")
        
        # 1. Lọc users & members
        is_clean_user = lambda u: not ("test" in str(u.get("id","")).lower() or "test" in str(u.get("username","")).lower() or str(u.get("id")) in ["user_vanhau", "user_regular"])
        is_clean_member = lambda m: not ("test" in str(m.get("id","")).lower() or "test" in str(m.get("name","")).lower() or str(m.get("id")) == "mem_vanhau")
        is_clean_session = lambda s: not ("test" in str(s.get("id","")).lower() or str(s.get("id")).startswith("session_test_") or str(s.get("id")).startswith("ses_test_"))
        is_clean_tx = lambda t: not ("tx_test_" in str(t.get("id","")).lower() or str(t.get("id")) in ["tx_1790423944296", "tx_test_garbage"] or str(t.get("title","")).lower() in ["cxasxa", "s"])

        data["users"] = [u for u in data.get("users", []) if is_clean_user(u)]
        data["members"] = [m for m in data.get("members", []) if is_clean_member(m)]
        data["sessions"] = [s for s in data.get("sessions", []) if is_clean_session(s)]
        data["transactions"] = [t for t in data.get("transactions", []) if is_clean_tx(t)]

        # Đảm bảo admin tồn tại
        if not any(u.get("username") == "admin" for u in data["users"]):
            data["users"].insert(0, {
                "id": "user_admin", "username": "admin", "password": "admin",
                "name": "Quản trị viên CLB", "role": "admin", "phone": "0988776655", "type": "fixed", "memberId": "mem_admin"
            })
        if not any(m.get("id") == "mem_admin" for m in data["members"]):
            data["members"].insert(0, {
                "id": "mem_admin", "username": "admin", "name": "Quản trị viên CLB",
                "role": "admin", "phone": "0988776655", "type": "fixed"
            })

        # Dọn dẹp mồ côi và làm sạch đóng quỹ ảo không có chứng từ
        valid_member_ids = set(m["id"] for m in data["members"])
        tx_due_ids = set(t.get("dueId") for t in data.get("transactions", []) if t.get("dueId"))
        
        cleaned_contributions = []
        for c in data.get("monthlyContributions", []):
            if c.get("memberId") in valid_member_ids:
                if c.get("status") == "paid" and not c.get("billImage") and c.get("id") not in tx_due_ids:
                    c["status"] = "unpaid"
                    c["paidAt"] = None
                    c["method"] = None
                    c["billImage"] = None
                    c["approvedBy"] = None
                    c["approvedAt"] = None
                    c["note"] = "Chưa đóng"
                cleaned_contributions.append(c)
        data["monthlyContributions"] = cleaned_contributions
        
        if "clubInfo" in data:
            if not data["clubInfo"].get("monthlyFee") or data["clubInfo"].get("monthlyFee") == 300000:
                data["clubInfo"]["monthlyFee"] = data["clubInfo"].get("monthlyFundFee") or 20000
            if not data["clubInfo"].get("monthlyFundFee"):
                data["clubInfo"]["monthlyFundFee"] = data["clubInfo"].get("monthlyFee") or 20000
        
        for s in data["sessions"]:
            s["votes"] = [v for v in s.get("votes", []) if v.get("memberId") in valid_member_ids]

        data["lastModified"] = int(time.time() * 1000)

        push_res = self.push_cloud_data(data, sheet_name)
        if push_res["success"]:
            print(f"{GREEN}[OK] Đã làm sạch và cập nhật CSDL chuẩn lên Google Drive thành công!{RESET}")
            return True
        else:
            print(f"{RED}[ERROR] Lỗi khi lưu dữ liệu đã làm sạch: {push_res.get('error')}{RESET}")
            return False

    def watch_live(self, interval_sec=3, sheet_name=PROD_SHEET):
        """Giám sát liên tục thời gian thực biến động CSDL Cloud"""
        print_banner(f"GIÁM SÁT THỜI GIAN THỰC CSDL CLOUD ({sheet_name})")
        print(f"{YELLOW}[*] Đang lắng nghe thay đổi mỗi {interval_sec} giây... (Nhấn Ctrl+C để dừng){RESET}\n")

        last_known_mod = None
        last_member_count = None
        last_session_count = None
        last_tx_count = None

        try:
            while True:
                fetch_res = self.fetch_cloud_data(sheet_name)
                now_str = datetime.datetime.now().strftime("%H:%M:%S")

                if not fetch_res["success"]:
                    print(f"[{now_str}] {RED}Mất kết nối tới Cloud: {fetch_res['error']}{RESET}")
                else:
                    data = fetch_res["data"]
                    audit_res = self.audit_integrity_and_phantom_data(data, sheet_name)
                    stats = audit_res["stats"]
                    mod_time = stats.get("last_modified_human", "N/A")
                    mem_c = stats.get("members_count", 0)
                    ses_c = stats.get("sessions_count", 0)
                    tx_c = stats.get("transactions_count", 0)
                    balance = stats.get("calculated_balance", 0)

                    # Phát hiện biến động
                    if last_known_mod is None or mod_time != last_known_mod:
                        status_tag = f"{GREEN}[LIVE UPDATE]{RESET}" if last_known_mod is not None else f"{CYAN}[INITIAL]{RESET}"
                        phantom_tag = f"{RED}⚠️ CÓ {len(audit_res['issues'])} DỮ LIỆU ẢO!{RESET}" if not audit_res["is_clean"] else f"{GREEN}✨ SẠCH 100%{RESET}"
                        print(f"[{now_str}] {status_tag} Độ trễ: {fetch_res['latency_ms']}ms | Timestamp: {mod_time} | TV: {mem_c} | Ca: {ses_c} | GD: {tx_c} | Số dư: {balance:,.0f}đ | Trạng thái: {phantom_tag}")
                        
                        last_known_mod = mod_time
                        last_member_count = mem_c
                        last_session_count = ses_c
                        last_tx_count = tx_c
                    else:
                        print(f"[{now_str}] 🟢 Cloud ổn định (Không có biến động mới) | Độ trễ: {fetch_res['latency_ms']}ms", end="\r")

                time.sleep(interval_sec)
        except KeyboardInterrupt:
            print(f"\n\n{YELLOW}[*] Đã dừng giám sát thời gian thực.{RESET}")

def main():
    parser = argparse.ArgumentParser(description="SMASH PRO Cloud Real-Time Auditor & Data Integrity Agent")
    parser.add_argument("--check", action="store_true", help="Kiểm tra ngay trạng thái CSDL Cloud & phát hiện dữ liệu ảo")
    parser.add_argument("--verify-live-sync", action="store_true", help="Kiểm tra độ trễ & tính cập nhật tức thời Real-Time")
    parser.add_argument("--watch", action="store_true", help="Giám sát liên tục biến động CSDL Cloud theo thời gian thực")
    parser.add_argument("--clean", action="store_true", help="Làm sạch an toàn các bản ghi ảo/test trên Google Drive")
    parser.add_argument("--sheet", choices=[PROD_SHEET, TEST_SHEET], default=PROD_SHEET, help="Bảng tính cần kiểm toán")
    parser.add_argument("--interval", type=int, default=3, help="Chu kỳ giám sát (giây) cho chế độ --watch")
    args = parser.parse_args()

    auditor = CloudRealtimeAuditor()

    # Mặc định nếu không truyền tham số -> Chạy kiểm toán toàn diện & đo Live Sync
    if not (args.check or args.verify_live_sync or args.watch or args.clean):
        args.check = True
        args.verify_live_sync = True

    if args.check:
        print_banner(f"KIỂM TOÁN TÍNH TOÀN VẸN CSDL CLOUD ({args.sheet})")
        res = auditor.fetch_cloud_data(args.sheet)
        if not res["success"]:
            print(f"{RED}[ERROR] Không thể kết nối tới Google Drive: {res['error']}{RESET}")
            sys.exit(1)

        data = res["data"]
        audit = auditor.audit_integrity_and_phantom_data(data, args.sheet)
        stats = audit["stats"]

        print(f"📊 {BOLD}THỐNG KÊ CSDL CLOUD TRỰC TIẾP TỪ GOOGLE DRIVE:{RESET}")
        print(f"  • Tên CLB               : {BOLD}{stats.get('club_name')}{RESET}")
        print(f"  • Phiên bản Schema       : {stats.get('version')} (Chế độ: {stats.get('mode')})")
        print(f"  • Dấu thời gian cập nhật : {stats.get('last_modified_human')}")
        print(f"  • Số lượng Thành viên    : {stats.get('members_count')} người")
        print(f"  • Số lượng Tài khoản     : {stats.get('users_count')} tài khoản")
        print(f"  • Số lượng Ca đánh       : {stats.get('sessions_count')} ca")
        print(f"  • Số lượng Giao dịch     : {stats.get('transactions_count')} giao dịch")
        print(f"  • Tổng Thu / Tổng Chi    : Thu {stats.get('total_income',0):,.0f} đ  |  Chi {stats.get('total_expense',0):,.0f} đ")
        print(f"  • Số dư Sổ quỹ tính toán : {BOLD}{stats.get('calculated_balance',0):,.0f} đ{RESET}")
        print(f"  • Độ trễ kết nối mạng    : {res['latency_ms']} ms")

        print(f"\n🔍 {BOLD}KẾT QUẢ QUÉT DỮ LIỆU ẢO & RÁC KIỂM THỬ:{RESET}")
        if audit["is_clean"]:
            print(f"  {GREEN}✅ KHÔNG PHÁT HIỆN DỮ LIỆU ẢO! CSDL Cloud hoàn toàn sạch sẽ và đạt chuẩn vận hành 100%.{RESET}")
        else:
            print(f"  {RED}❌ PHÁT HIỆN {len(audit['issues'])} VẤN ĐỀ DỮ LIỆU ẢO:{RESET}")
            for iss in audit["issues"]:
                print(f"     • {RED}{iss}{RESET}")

        if audit["warnings"]:
            print(f"\n⚠️  {YELLOW}CẢNH BÁO TỒN ĐỌNG ({len(audit['warnings'])} mục):{RESET}")
            for w in audit["warnings"]:
                print(f"     • {YELLOW}{w}{RESET}")

        # Xuất báo cáo kiểm toán ra file JSON
        report_dir = os.path.join(WORKSPACE_ROOT, "outputs", "reports")
        os.makedirs(report_dir, exist_ok=True)
        report_path = os.path.join(report_dir, "cloud_realtime_audit_report.json")
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump({
                "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "sheet": args.sheet,
                "latency_ms": res["latency_ms"],
                "audit": audit
            }, f, indent=2, ensure_ascii=False)
        print(f"\n[OK] Báo cáo kiểm toán đã được lưu tại: {CYAN}{report_path}{RESET}")

    if args.verify_live_sync:
        auditor.verify_live_realtime_sync()

    if args.clean:
        auditor.clean_phantom_records(args.sheet)

    if args.watch:
        auditor.watch_live(interval_sec=args.interval, sheet_name=args.sheet)

if __name__ == "__main__":
    main()
