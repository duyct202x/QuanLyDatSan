import requests
import json
import time
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

CLOUD_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec"

print("1. Tải CSDL hiện hành từ Google Drive CSDL_VanHanh_Prod...")
resp = requests.get(f"{CLOUD_URL}?sheet=CSDL_VanHanh_Prod", timeout=30)
cloud_data = resp.json()

print("Dữ liệu hiện hành trên Cloud:")
print(f"  - Thành viên: {len(cloud_data.get('members', []))}")
print(f"  - Tài khoản : {len(cloud_data.get('users', []))}")

# Danh sách ID cần xóa sạch vĩnh viễn (bao gồm Nguyễn Quang Hải)
deleted_members = ["mem_1790479550427"]
deleted_users = ["user_1790479550427", "0912345678"]

# Lọc sạch members
cloud_data['members'] = [m for m in cloud_data.get('members', []) if m.get('id') not in deleted_members and m.get('name') != 'Nguyễn Quang Hải' and m.get('phone') != '0912345678']

# Lọc sạch users
cloud_data['users'] = [u for u in cloud_data.get('users', []) if u.get('id') not in deleted_users and u.get('username') != '0912345678' and u.get('name') != 'Nguyễn Quang Hải']

# Đảm bảo có tombstones
existing_del_members = cloud_data.get('deletedMemberIds', [])
existing_del_users = cloud_data.get('deletedUserIds', [])
cloud_data['deletedMemberIds'] = list(set(existing_del_members + deleted_members))
cloud_data['deletedUserIds'] = list(set(existing_del_users + deleted_users))

# Đặt currentUser về null để bảo mật
cloud_data['currentUser'] = None
cloud_data['lastModified'] = int(time.time() * 1000)

print("\n2. Đang đồng bộ CSDL sạch lên Google Drive...")
post_resp = requests.post(
    f"{CLOUD_URL}?sheet=CSDL_VanHanh_Prod",
    data=json.dumps(cloud_data),
    headers={"Content-Type": "text/plain;charset=utf-8"},
    timeout=30
)
print("Kết quả đẩy Cloud:", post_resp.status_code, post_resp.text)

print("\n3. Xác thực lại CSDL trên Cloud:")
check_resp = requests.get(f"{CLOUD_URL}?sheet=CSDL_VanHanh_Prod", timeout=30)
verified_data = check_resp.json()
print(f"  - Thành viên còn lại: {[(m.get('id'), m.get('name')) for m in verified_data.get('members', [])]}")
print(f"  - Tài khoản còn lại : {[(u.get('id'), u.get('username'), u.get('name')) for u in verified_data.get('users', [])]}")
print(f"  - Tombstones Members : {verified_data.get('deletedMemberIds', [])}")
print(f"  - Tombstones Users   : {verified_data.get('deletedUserIds', [])}")
print(f"  - Current User       : {verified_data.get('currentUser')}")
