import json
import requests
import time
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec?sheet=CSDL_VanHanh_Prod"

resp = requests.get(URL, timeout=20)
data = resp.json()

print(f"Current version: {data.get('version')}, lastModified: {data.get('lastModified')}")

# Tạo danh sách contributions sạch, tất cả status = 'unpaid', không có ai paid
clean_dues = []
for m in data.get("members", []):
    if m.get("type") == "fixed":
        clean_dues.append({
            "id": f"due_2026-09_{m['id']}",
            "month": "2026-09",
            "memberId": m["id"],
            "amount": 20000,
            "status": "unpaid",
            "paidAt": None,
            "method": None,
            "billImage": None,
            "approvedBy": None,
            "approvedAt": None,
            "note": "Chưa đóng"
        })

data["monthlyContributions"] = clean_dues
data["lastModified"] = int(time.time() * 1000)

payload_str = json.dumps(data, ensure_ascii=False)
headers = {"Content-Type": "text/plain;charset=utf-8"}

print("Sending pure clean unpaid contributions...")
post_resp = requests.post(URL, data=payload_str.encode('utf-8'), headers=headers, timeout=25)
print("Post response:", post_resp.text)

# Đợi 2s và đọc lại
time.sleep(2)
check_resp = requests.get(URL, timeout=20)
check_data = check_resp.json()

print("\n--- KIỂM TRA LẠI SAU KHI PUSH ---")
for d in check_data.get("monthlyContributions", []):
    print(f"MemberId: {d.get('memberId')} -> Status: {d.get('status')}, Amount: {d.get('amount')}, PaidAt: {d.get('paidAt')}")
