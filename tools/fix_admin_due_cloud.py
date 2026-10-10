import json
import urllib.request
import urllib.parse
import sys

if sys.platform.startswith('win'):
    sys.stdout.reconfigure(encoding='utf-8')

URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec?sheet=CSDL_VanHanh_Prod"

# 1. Fetch current cloud data
req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode('utf-8'))

# 2. Reset mem_admin to unpaid
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

# 3. Standardize clubInfo fees to 20,000
if "clubInfo" in data:
    data["clubInfo"]["monthlyFee"] = 20000
    data["clubInfo"]["monthlyFundFee"] = 20000

# 4. Push clean data back to Cloud
payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
post_req = urllib.request.Request(
    URL,
    data=payload,
    headers={
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0"
    },
    method="POST"
)

with urllib.request.urlopen(post_req) as resp:
    res = json.loads(resp.read().decode('utf-8'))
    print("Push to Cloud result:", res)

print("\n=== CLOUD DATA UPDATED SUCCESSFULLY ===")
