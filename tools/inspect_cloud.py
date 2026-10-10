import json
import urllib.request
import urllib.parse
import sys

if sys.platform.startswith('win'):
    sys.stdout.reconfigure(encoding='utf-8')

URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec?sheet=CSDL_VanHanh_Prod"

req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode('utf-8'))

print("=== CLOUD PROD STATE ===")
print("Club Info:", json.dumps(data.get("clubInfo", {}), ensure_ascii=False, indent=2))
print("\nMembers:", json.dumps(data.get("members", []), ensure_ascii=False, indent=2))
print("\nUsers:", json.dumps(data.get("users", []), ensure_ascii=False, indent=2))
print("\nContributions:", json.dumps(data.get("monthlyContributions", []), ensure_ascii=False, indent=2))
print("\nTransactions:", json.dumps(data.get("transactions", []), ensure_ascii=False, indent=2))
