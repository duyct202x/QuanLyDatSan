#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
================================================================================
SMASH PRO - TRANSACTION INTEGRITY GUARDIAN AGENT & ENGINE
Agent Độc Lập Chuyên Sâu Kiểm Soát Giao Dịch, Chống Gian Lận, Lỗi & Khắc Phục Dữ Liệu Rác:
1. Kiểm toán Tính Toàn Vẹn Từng Giao Dịch (Schema, ID, Amount > 0, Date, Title, Type).
2. Đối soát Liên kết 1-1 giữa Quỹ Tháng (Monthly Contributions) và Sổ Quỹ (Transactions).
3. Xác thực Số Dư Kế Toán: Số Dư = Tổng Thu - Tổng Chi (Zero Discrepancy).
4. Khắc phục Triệt Để Tình Trạng Dữ Liệu Rác, Chuỗi Vô Nghĩa & Giao Dịch Kiểm Thử/Probe.
5. Xuất Báo Cáo Kiểm Toán Tài Chính JSON ra outputs/reports/transaction_guardian_report.json.
================================================================================
"""

import os
import sys
import time
import json
import argparse
import datetime
import urllib.parse

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, WORKSPACE_ROOT)

GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec"
PROD_SHEET = "CSDL_VanHanh_Prod"
TEST_SHEET = "CSDL_KiemThu_Test"
REPORT_PATH = os.path.join(WORKSPACE_ROOT, "outputs", "reports", "transaction_guardian_report.json")

# Console formatting
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

class TransactionIntegrityGuardian:
    def __init__(self, script_url=GOOGLE_SCRIPT_URL):
        self.script_url = script_url

    def fetch_cloud_data(self, sheet_name=PROD_SHEET):
        """Tải dữ liệu trực tiếp từ Google Drive Endpoint"""
        url = f"{self.script_url}?sheet={urllib.parse.quote(sheet_name)}&_t={int(time.time()*1000)}"
        start_time = time.time()
        try:
            import requests
            resp = requests.get(url, headers={"Accept": "application/json"}, timeout=15)
            latency_ms = int((time.time() - start_time) * 1000)
            data = resp.json()
            return {
                "success": True,
                "latency_ms": latency_ms,
                "data": data
            }
        except Exception as e:
            latency_ms = int((time.time() - start_time) * 1000)
            return {
                "success": False,
                "latency_ms": latency_ms,
                "error": str(e),
                "data": None
            }

    def push_cloud_data(self, data, sheet_name=PROD_SHEET):
        """Đẩy dữ liệu cập nhật an toàn lên Google Drive"""
        url = f"{self.script_url}?sheet={urllib.parse.quote(sheet_name)}"
        data["sheetName"] = sheet_name
        data["lastModified"] = int(time.time() * 1000)
        start_time = time.time()
        try:
            import requests
            payload_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
            resp = requests.post(
                url,
                data=payload_bytes,
                headers={"Content-Type": "text/plain;charset=utf-8"},
                timeout=30
            )
            latency_ms = int((time.time() - start_time) * 1000)
            return {
                "success": resp.status_code == 200,
                "status_code": resp.status_code,
                "latency_ms": latency_ms,
                "response_text": resp.text
            }
        except Exception as e:
            latency_ms = int((time.time() - start_time) * 1000)
            return {
                "success": False,
                "error": str(e),
                "latency_ms": latency_ms
            }

    def audit_transactions(self, data):
        """
        Kiểm toán chuyên sâu tính toàn vẹn sổ quỹ và phát hiện dữ liệu lỗi / rác
        """
        issues = []
        warnings = []
        garbage_txs = []
        valid_txs = []
        
        transactions = data.get("transactions", []) or []
        members = data.get("members", []) or []
        dues = data.get("monthlyContributions", []) or []
        
        member_ids = {m.get("id") for m in members if m.get("id")}
        fixed_member_ids = {m.get("id") for m in members if m.get("type") == "fixed"}
        
        total_income = 0
        total_expense = 0
        tx_id_set = set()
        due_tx_map = {}

        # 1. Kiểm toán từng giao dịch trong sổ quỹ
        for idx, t in enumerate(transactions):
            t_id = str(t.get("id", "")).strip()
            title = str(t.get("title") or t.get("description") or "").strip()
            amount_raw = t.get("amount")
            t_type = t.get("type")
            category = t.get("category", "Khác")
            date_str = str(t.get("date", ""))
            due_id = t.get("dueId")

            # Kiểm tra ID
            if not t_id:
                issues.append(f"Giao dịch #{idx+1} thiếu ID định danh")
                garbage_txs.append(t)
                continue

            if t_id in tx_id_set:
                issues.append(f"Phát hiện giao dịch trùng lặp ID '{t_id}'")
                garbage_txs.append(t)
                continue
            tx_id_set.add(t_id)

            # Kiểm tra rác / probe / test
            is_garbage = False
            if t_id.startswith("realtime_audit_probe_") or t_id.startswith("tx_test_") or t_id == "tx_1790423944296" or t_id == "tx_test_garbage":
                is_garbage = True
            if title.lower() in ["cxasxa", "s", "test", ""] or category == "audit_probe":
                is_garbage = True

            # Kiểm tra số tiền
            try:
                amount = float(amount_raw)
                if amount <= 0:
                    is_garbage = True
                    issues.append(f"Giao dịch '{t_id}' ({title}) có số tiền không hợp lệ: {amount}")
            except (ValueError, TypeError):
                is_garbage = True
                issues.append(f"Giao dịch '{t_id}' ({title}) có số tiền không phải dạng số: {amount_raw}")
                amount = 0

            # Kiểm tra loại thu / chi
            if t_type not in ["income", "expense"]:
                is_garbage = True
                issues.append(f"Giao dịch '{t_id}' ({title}) có loại không hợp lệ: '{t_type}' (Phải là 'income' hoặc 'expense')")

            if is_garbage:
                garbage_txs.append(t)
                issues.append(f"Phát hiện giao dịch rác/vô căn cứ: ID='{t_id}', Tiêu đề='{title}', Tiền={amount:,.0f}đ")
            else:
                valid_txs.append(t)
                if t_type == "income":
                    total_income += amount
                else:
                    total_expense += amount

                if due_id:
                    if due_id in due_tx_map:
                        issues.append(f"Giao dịch thu quỹ bị tạo đúp cho cùng mã đóng quỹ '{due_id}' (ID: {t_id})")
                    due_tx_map[due_id] = t

        # 2. Đối soát liên kết với Quỹ Tháng (Monthly Contributions)
        paid_dues = [d for d in dues if d.get("status") == "paid"]
        for d in paid_dues:
            d_id = d.get("id")
            d_mem = d.get("memberId")
            d_amount = float(d.get("amount", 300000))
            if d_id not in due_tx_map:
                warnings.append(f"Thành viên '{d_mem}' đã đóng quỹ ({d_id}) nhưng chưa được ghi nhận vào Sổ quỹ!")

        # 3. Tính toán số dư
        calculated_balance = total_income - total_expense

        return {
            "total_transactions": len(transactions),
            "valid_transactions_count": len(valid_txs),
            "garbage_transactions_count": len(garbage_txs),
            "total_income": total_income,
            "total_expense": total_expense,
            "calculated_balance": calculated_balance,
            "issues": issues,
            "warnings": warnings,
            "garbage_txs": garbage_txs,
            "valid_txs": valid_txs,
            "is_clean": len(issues) == 0 and len(garbage_txs) == 0
        }

    def run_full_audit(self, sheet_name=PROD_SHEET):
        """Thực thi kiểm toán toàn diện và in báo cáo chuyên nghiệp"""
        print_banner(f"KIỂM TOÁN GIAO DỊCH & SỔ QUỸ TÀI CHÍNH ({sheet_name})")
        
        fetch_res = self.fetch_cloud_data(sheet_name)
        if not fetch_res["success"]:
            print(f"{RED}[ERROR] Không thể kết nối tới Google Drive: {fetch_res['error']}{RESET}")
            return None

        data = fetch_res["data"]
        audit_res = self.audit_transactions(data)

        print(f"📊 {BOLD}KẾT QUẢ ĐỐI SOÁT SỔ QUỸ & SỐ DƯ TÀI CHÍNH:{RESET}")
        print(f"  • Độ trễ kết nối Cloud     : {fetch_res['latency_ms']} ms")
        print(f"  • Tổng số giao dịch hiện có: {audit_res['total_transactions']} giao dịch")
        print(f"  • Giao dịch hợp lệ         : {audit_res['valid_transactions_count']} giao dịch")
        print(f"  • Giao dịch rác / lỗi      : {audit_res['garbage_transactions_count']} giao dịch")
        print(f"  • Tổng Thu (Income)        : {audit_res['total_income']:,.0f} đ")
        print(f"  • Tổng Chi (Expense)       : {audit_res['total_expense']:,.0f} đ")
        print(f"  • {BOLD}Số dư sổ quỹ tính toán   : {audit_res['calculated_balance']:,.0f} đ{RESET}")

        print(f"\n🔍 {BOLD}ĐÁNH GIÁ TÍNH TOÀN VẸN:{RESET}")
        if audit_res["is_clean"]:
            print(f"  {GREEN}✅ SỔ QUỸ HOÀN TOÀN CHÍNH XÁC & SẠCH SẼ 100%! Không có giao dịch rác hay sai lệch.{RESET}")
        else:
            print(f"  {RED}❌ PHÁT HIỆN {len(audit_res['issues'])} VẤN ĐỀ VÀ {len(audit_res['garbage_txs'])} GIAO DỊCH RÁC/LỖI!{RESET}")
            for issue in audit_res["issues"]:
                print(f"    - {RED}[LỖI]{RESET} {issue}")
            for warn in audit_res["warnings"]:
                print(f"    - {YELLOW}[CẢNH BÁO]{RESET} {warn}")

        # Lưu báo cáo JSON
        os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
        report_data = {
            "timestamp": datetime.datetime.now().isoformat(),
            "sheet_name": sheet_name,
            "latency_ms": fetch_res["latency_ms"],
            "audit_result": audit_res
        }
        with open(REPORT_PATH, "w", encoding="utf-8") as f:
            json.dump(report_data, f, ensure_ascii=False, indent=2)
        print(f"\n[OK] Báo cáo đã được xuất ra: {REPORT_PATH}")

        return audit_res

    def clean_garbage_transactions(self, sheet_name=PROD_SHEET):
        """Lọc sạch triệt để mọi giao dịch rác / probe / kiểm thử trên Cloud"""
        print_banner(f"LÀM SẠCH VÀ CHUẨN HÓA GIAO DỊCH SỔ QUỸ ({sheet_name})")
        
        fetch_res = self.fetch_cloud_data(sheet_name)
        if not fetch_res["success"]:
            print(f"{RED}[ERROR] Không thể kết nối tới Google Drive: {fetch_res['error']}{RESET}")
            return False

        data = fetch_res["data"]
        audit_res = self.audit_transactions(data)

        if audit_res["garbage_transactions_count"] == 0 and audit_res["is_clean"]:
            print(f"{GREEN}[OK] CSDL Cloud đã sạch sẽ 100%, không cần dọn dẹp.{RESET}")
            return True

        print(f"[*] Đang tiến hành loại bỏ {len(audit_res['garbage_txs'])} giao dịch rác...")
        data["transactions"] = audit_res["valid_txs"]
        
        push_res = self.push_cloud_data(data, sheet_name)
        if push_res["success"]:
            print(f"{GREEN}[OK] Đã làm sạch và cập nhật CSDL Cloud thành công! Độ trễ ghi: {push_res['latency_ms']} ms{RESET}")
            print(f"  • Số giao dịch còn lại: {len(data['transactions'])}")
            print(f"  • Số dư sổ quỹ chuẩn  : {audit_res['calculated_balance']:,.0f} đ")
            return True
        else:
            print(f"{RED}[ERROR] Cập nhật Cloud thất bại: {push_res.get('error')}{RESET}")
            return False

def main():
    parser = argparse.ArgumentParser(description="SMASH PRO - Transaction Integrity Guardian Agent")
    parser.add_argument("--audit", action="store_true", help="Kiểm toán toàn diện tính toàn vẹn sổ quỹ và số dư")
    parser.add_argument("--clean-garbage", action="store_true", help="Lọc sạch mọi giao dịch rác / probe / test")
    parser.add_argument("--sheet", default=PROD_SHEET, help=f"Tên sheet Cloud (mặc định: {PROD_SHEET})")

    args = parser.parse_args()
    guardian = TransactionIntegrityGuardian()

    if args.clean_garbage:
        guardian.clean_garbage_transactions(args.sheet)
    else:
        guardian.run_full_audit(args.sheet)

if __name__ == "__main__":
    main()
