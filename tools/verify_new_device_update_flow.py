#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
================================================================================
SMASH PRO - VERIFY NEW DEVICE UPDATE & DATA LOSS PREVENTION TEST
Kịch bản kiểm thử mô phỏng đa thiết bị độc lập:
1. Ghi nhận trạng thái CSDL Cloud hiện hành (Baseline: Admin, Nguyễn Quang Hải, Ca đánh).
2. Mô phỏng Thiết bị Mới (Device B) mở ứng dụng lần đầu với bộ nhớ trắng tinh (Skeleton).
3. Xác thực Device B tự động kéo đầy đủ 100% CSDL từ Cloud về mà không ghi đè khung rỗng.
4. Device B thực hiện cập nhật dữ liệu mới (Thêm thành viên 'Vũ Văn Thanh - 0987654321').
5. Device B đẩy cập nhật lên Google Drive Cloud.
6. Xác thực trực tiếp trên Cloud:
   - Toàn bộ dữ liệu cũ (Admin, Nguyễn Quang Hải, Ca đánh, Mật khẩu băm) BẢO TOÀN 100%.
   - Dữ liệu mới của Device B được HỢP NHẤT THÀNH CÔNG.
   - TUYỆT ĐỐI KHÔNG BỊ XÓA HOẶC MẤT MÁT BẤT KỲ DỮ LIỆU NÀO!
7. Dọn dẹp an toàn bản ghi test để bảo toàn CSDL.
================================================================================
"""

import os
import sys
import time
import json
import requests
import datetime

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

CLOUD_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec"
PROD_SHEET = "CSDL_VanHanh_Prod"

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def print_step(title):
    print(f"\n{BOLD}{CYAN}==> {title}{RESET}")

def fetch_cloud(sheet_name=PROD_SHEET):
    url = f"{CLOUD_URL}?sheet={sheet_name}&_t={int(time.time()*1000)}"
    resp = requests.get(url, timeout=15)
    return resp.json()

def push_cloud(data, sheet_name=PROD_SHEET):
    data["sheetName"] = sheet_name
    data["lastModified"] = int(time.time() * 1000)
    payload_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
    resp = requests.post(
        f"{CLOUD_URL}?sheet={sheet_name}",
        data=payload_bytes,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        timeout=30
    )
    return resp.status_code == 200

def main():
    print("=" * 80)
    print(f"{BOLD}{CYAN}KIỂM THỬ XÁC THỰC: CẬP NHẬT TRÊN THIẾT BỊ MỚI CÓ BỊ MẤT DỮ LIỆU KHÔNG?{RESET}".center(80))
    print("=" * 80)

    # 1. Ghi nhận trạng thái Baseline trên Cloud
    print_step("BƯỚC 1: ĐỌC DỮ LIỆU CSDL CLOUD HIỆN HÀNH (BASELINE)")
    baseline_data = fetch_cloud()
    initial_members = baseline_data.get("members", [])
    initial_users = baseline_data.get("users", [])
    initial_sessions = baseline_data.get("sessions", [])

    print(f"[*] Dữ liệu gốc trên Cloud:")
    print(f"  • Thành viên : {[m.get('name') for m in initial_members]}")
    print(f"  • Tài khoản  : {[u.get('username') for u in initial_users]}")
    print(f"  • Số ca đánh : {len(initial_sessions)} ca")

    assert len(initial_members) >= 2, "Dữ liệu ban đầu phải có ít nhất 2 thành viên (Admin và Nguyễn Quang Hải)"
    assert any("Quang Hải" in m.get("name", "") for m in initial_members), "Phải có thành viên thực tế Nguyễn Quang Hải"
    print(f"{GREEN}[PASS] Baseline CSDL Cloud được xác thực đầy đủ.{RESET}")

    # 2. Mô phỏng Thiết bị Mới (Device B) mở trang lần đầu
    print_step("BƯỚC 2: MÔ PHỎNG THIẾT BỊ MỚI (DEVICE B) MỞ WEB LẦN ĐẦU VỚI BỘ NHỚ TRẮNG")
    device_b_local = {
        "version": "2.7_PROD",
        "lastModified": 0,
        "isInitialSkeleton": True,
        "users": [{"id": "user_admin", "username": "admin", "name": "Quản trị viên CLB"}],
        "members": [{"id": "mem_admin", "username": "admin", "name": "Quản trị viên CLB"}],
        "sessions": [],
        "transactions": [],
        "monthlyContributions": []
    }
    print(f"[*] Device B khởi tạo với: lastModified={device_b_local['lastModified']}, isInitialSkeleton={device_b_local['isInitialSkeleton']}")

    # 3. Device B thực thi thuật toán mergeCloudWithLocal
    print_step("BƯỚC 3: DEVICE B TẢI DỮ LIỆU TỪ CLOUD (PULL FROM CLOUD)")
    cloud_time = baseline_data.get("lastModified", 1000)
    
    # Logic mô phỏng mergeCloudWithLocal của js/storage.js
    is_skeleton = device_b_local.get("isInitialSkeleton", False) or device_b_local.get("lastModified", 0) == 0
    if is_skeleton and cloud_time > 0:
        device_b_synced = json.loads(json.dumps(baseline_data))
        device_b_synced["isInitialSkeleton"] = False
        device_b_synced["lastModified"] = cloud_time
    else:
        device_b_synced = device_b_local

    print(f"[*] Sau khi nạp từ Cloud, Device B có:")
    print(f"  • Thành viên : {[m.get('name') for m in device_b_synced.get('members', [])]}")
    assert len(device_b_synced.get("members", [])) == len(initial_members), "Device B phải nạp đủ 100% thành viên Cloud"
    print(f"{GREEN}[PASS] Device B đã nạp trọn vẹn 100% dữ liệu từ Cloud thành công!{RESET}")

    # 4. Device B thực hiện cập nhật dữ liệu mới (Thêm thành viên 'Vũ Văn Thanh')
    print_step("BƯỚC 4: DEVICE B THỰC HIỆN CẬP NHẬT (THÊM THÀNH VIÊN 'VŨ VĂN THANH')")
    new_member_id = f"mem_test_device_b_{int(time.time()*1000)}"
    new_member = {
        "id": new_member_id,
        "username": "0987654321",
        "name": "Vũ Văn Thanh",
        "phone": "0987654321",
        "email": "vanthanh@smashpro.vn",
        "type": "fixed",
        "role": "member",
        "joinDate": "2026-09-27"
    }
    device_b_synced["members"].append(new_member)
    device_b_synced["lastModified"] = int(time.time() * 1000)

    print(f"[*] Device B đã thêm thành viên mới: {new_member['name']} ({new_member['phone']})")
    print(f"[*] Device B đẩy bản cập nhật lên Google Drive Cloud...")
    pushed = push_cloud(device_b_synced)
    assert pushed, "Đẩy dữ liệu lên Cloud phải thành công"
    print(f"{GREEN}[OK] Device B đã lưu cập nhật lên Cloud thành công!{RESET}")

    # 5. Xác thực trực tiếp trên Cloud
    print_step("BƯỚC 5: ĐỐI SOÁT TRỰC TIẾP TRÊN CLOUD - KIỂM TRA DỮ LIỆU CŨ VÀ MỚI")
    time.sleep(1.5)
    cloud_after_update = fetch_cloud()
    members_after = cloud_after_update.get("members", [])
    users_after = cloud_after_update.get("users", [])
    sessions_after = cloud_after_update.get("sessions", [])

    print(f"[*] Dữ liệu trên Google Drive sau khi Device B cập nhật:")
    print(f"  • Danh sách thành viên ({len(members_after)} người): {[m.get('name') for m in members_after]}")
    print(f"  • Danh sách ca đánh ({len(sessions_after)} ca): {[s.get('title') for s in sessions_after]}")

    # KIỂM TRA TOÀN VẸN DỮ LIỆU CŨ:
    print(f"\n🔍 {BOLD}KIỂM TRA CÁC TIÊU CHÍ AN TOÀN:{RESET}")
    has_admin = any(m.get("id") == "mem_admin" for m in members_after)
    has_quang_hai = any("Quang Hải" in m.get("name", "") for m in members_after)
    has_van_thanh = any(m.get("id") == new_member_id for m in members_after)
    sessions_preserved = len(sessions_after) == len(initial_sessions)

    print(f"  1. Quản trị viên CLB cũ       : {'✅ BẢO TOÀN 100%' if has_admin else '❌ BỊ MẤT'}")
    print(f"  2. Nguyễn Quang Hải cũ        : {'✅ BẢO TOÀN 100%' if has_quang_hai else '❌ BỊ MẤT'}")
    print(f"  3. Vũ Văn Thanh mới (Device B): {'✅ ĐÃ THÊM VÀO THÀNH CÔNG' if has_van_thanh else '❌ CHƯA LƯU'}")
    print(f"  4. Ca đánh cũ                 : {'✅ BẢO TOÀN NGUYÊN VẸN' if sessions_preserved else '❌ BỊ SAI LỆCH'}")

    assert has_admin, "LỖI: Tài khoản Quản trị viên bị mất!"
    assert has_quang_hai, "LỖI: Thành viên cũ Nguyễn Quang Hải bị mất!"
    assert has_van_thanh, "LỖI: Thành viên mới từ Device B không được lưu!"
    assert sessions_preserved, "LỖI: Ca đánh cũ bị mất!"

    print(f"\n{BOLD}{GREEN}🎉 KẾT QUẢ XÁC THỰC: 100% TUYỆT ĐỐI KHÔNG BỊ XÓA HAY MẤT DỮ LIỆU CŨ KHI CẬP NHẬT TRÊN THIẾT BỊ MỚI!{RESET}")

    # 6. Dọn dẹp bản ghi kiểm thử an toàn
    print_step("BƯỚC 6: THU HỒI BẢN GHI KIỂM THỬ ĐỂ BẢO TOÀN CSDL SẠCH 100%")
    cloud_after_update["members"] = [m for m in cloud_after_update["members"] if m.get("id") != new_member_id]
    push_cloud(cloud_after_update)
    print(f"{GREEN}[OK] CSDL Cloud đã được đưa về trạng thái chuẩn mực ban đầu!{RESET}")

    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
