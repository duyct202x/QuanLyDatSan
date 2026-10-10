import requests
import json
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

url = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec?sheet=CSDL_VanHanh_Prod"
r = requests.get(url)
print("Status Code:", r.status_code)
print("Raw Response Text Length:", len(r.text))
try:
    data = r.json()
    print("Parsed JSON successfully!")
    print("Club Name:", data.get("clubInfo", {}).get("name"))
    print("lastModified:", data.get("lastModified"))
    print("Members Count:", len(data.get("members", [])))
    print("Sessions Count:", len(data.get("sessions", [])))
    print("Transactions Count:", len(data.get("transactions", [])))
except Exception as e:
    print("Parse error:", e)
    print("Raw content snippet:", r.text[:500])
