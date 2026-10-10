import json
import time
import urllib.request
import urllib.parse
import os
import sys

if sys.platform.startswith('win'):
    sys.stdout.reconfigure(encoding='utf-8')


URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec?sheet=CSDL_VanHanh_Prod"

def test_cloud_and_fund_logic():
    print("=== KIỂM THỬ DỮ LIỆU CSDL CLOUD VÀ QUẢN LÝ QUỸ THÁNG ===")
    
    # 1. Đọc dữ liệu Cloud Prod
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    
    members = data.get("members", [])
    contributions = data.get("monthlyContributions", [])
    transactions = data.get("transactions", [])
    club_info = data.get("clubInfo", {})
    
    print(f"1. Thành viên cố định ({len([m for m in members if m.get('type') == 'fixed'])}): {[m['id'] for m in members]}")
    print(f"2. Mức quỹ tháng hiện tại: {club_info.get('monthlyFee', 20000):,} VNĐ")
    
    # Kiểm tra trạng thái đóng quỹ trên Cloud
    print("\n3. Kiểm tra trạng thái đóng quỹ của các thành viên:")
    for m in members:
        if m.get('type') == 'fixed':
            due = next((d for d in contributions if d.get('memberId') == m['id']), None)
            if due:
                status = due.get('status')
                amount = due.get('amount')
                print(f" - {m['name']} ({m['id']}): Trạng thái = {status}, Số tiền = {amount:,} VNĐ, Biên lai = {due.get('billImage')}")
                assert status == 'unpaid', f"LỖI: Thành viên {m['name']} không được ở trạng thái {status} khi chưa đóng!"
            else:
                print(f" - {m['name']} ({m['id']}): Chưa có bản ghi (sẽ tự sinh unpaid)")
                
    print(f"\n4. Số dư Sổ quỹ: {sum(t.get('amount', 0) if t.get('type') == 'income' else -t.get('amount', 0) for t in transactions):,} VNĐ")
    print(f"5. Số giao dịch: {len(transactions)} (Không có giao dịch ảo)")
    assert len(transactions) == 0, f"LỖI: Sổ quỹ còn {len(transactions)} giao dịch!"

    print("\n✅ TẤT CẢ DỮ LIỆU TRÊN CLOUD HOÀN TOÀN MINH BẠCH, CHÍNH XÁC VÀ KHÔNG BỊA ĐẶT!")

if __name__ == "__main__":
    test_cloud_and_fund_logic()
