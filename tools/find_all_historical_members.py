import os
import json
import re
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

search_dir = r"c:\Users\Dcatrus\Documents\Projects\QuanLyDatSan"
found_members = {}
found_users = {}

for root, dirs, files in os.walk(search_dir):
    if '.git' in root: continue
    for f in files:
        if f.endswith('.json') or f.endswith('.py') or f.startswith('f_'):
            full_path = os.path.join(root, f)
            try:
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as fp:
                    content = fp.read()
                    # Find all member-like objects
                    # regex for {"id": "mem_...", "name": "..."}
                    for m in re.finditer(r'\{[^{}]*?"id"\s*:\s*"(mem_[^"]+)"[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?\}', content):
                        mem_id = m.group(1)
                        mem_name = m.group(2)
                        if mem_id not in found_members:
                            found_members[mem_id] = {'raw': m.group(0), 'name': mem_name, 'file': full_path}
                    # Alternative order: name before id
                    for m in re.finditer(r'\{[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?"id"\s*:\s*"(mem_[^"]+)"[^{}]*?\}', content):
                        mem_name = m.group(1)
                        mem_id = m.group(2)
                        if mem_id not in found_members:
                            found_members[mem_id] = {'raw': m.group(0), 'name': mem_name, 'file': full_path}
                    # Also look for registration names like Dang Quang Hien, Hua Vi Vi Hieu, etc.
                    for name in ['Đặng Quang Hiển', 'Hứa Vĩ Vi Hiếu', 'Nguyễn Văn Tuấn', 'Trần Mai Anh', 'Lê Hoàng Long', 'Phạm Minh Đức', 'Nguyễn Thảo Vy', 'Trần Bảo Nam', 'Dcatrus Gao', 'Nguyễn Quang Hải']:
                        if name in content and name not in [x['name'] for x in found_members.values()]:
                            print(f"Found name '{name}' in {full_path}")
            except Exception as e:
                pass

print(f"\n=== TÌM THẤY TỔNG CỘNG {len(found_members)} THÀNH VIÊN ===")
for mid, info in found_members.items():
    print(f"- [{mid}] : {info['name']} (from {info['file']})")
    print(f"  Raw: {info['raw']}")
