import json
import requests
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec?sheet=CSDL_VanHanh_Prod"

# 1. Fetch current cloud data
resp = requests.get(URL, timeout=20)
data = resp.json()

print(f"Current version: {data.get('version')}, lastModified: {data.get('lastModified')}")

# 2. Reset mem_admin to unpaid (Chưa đóng)
for due in data.get("monthlyContributions", []):
    if due.get("memberId") == "mem_admin":
        due["status"] = "unpaid"
        due["paidAt"] = None
        due["method"] = None
        due["billImage"] = None
        due["approvedBy"] = None
        due["approvedAt"] = None
        due["note"] = "Chưa đóng"
        due["amount"] = 20000
    if due.get("memberId") == "mem_1790507386718":
        due["amount"] = 20000
        due["status"] = "unpaid"

# 3. Standardize clubInfo fees to 20,000
if "clubInfo" in data:
    data["clubInfo"]["monthlyFee"] = 20000
    data["clubInfo"]["monthlyFundFee"] = 20000

# Update timestamp to force sync
import time
data["lastModified"] = int(time.time() * 1000)

# 4. Push clean data back to Cloud
payload_str = json.dumps(data, ensure_ascii=False)
headers = {"Content-Type": "text/plain;charset=utf-8"}

print("Pushing updated data to Cloud Prod...")
post_resp = requests.post(URL, data=payload_str.encode('utf-8'), headers=headers, timeout=25)
print("Push status:", post_resp.status_code)
print("Push response:", post_resp.text)
