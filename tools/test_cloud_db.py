#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: test_cloud_db.py
Mục đích: Khởi tạo và kiểm thử CSDL Vận hành thực tế (Production) và CSDL Kiểm thử (Test Demo)
trên Google Apps Script & Google Sheets.
"""

import os
import sys
import json
import urllib.request
import urllib.parse
import datetime

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

CLOUD_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec"

# 1. CSDL VẬN HÀNH THỰC TẾ (PRODUCTION)
PROD_DATABASE = {
    "version": "2.0_PROD",
    "mode": "production",
    "sheetName": "CSDL_VanHanh_Prod",
    "clubInfo": {
        "name": "SMASH PRO Badminton Club",
        "shortName": "SMASH PRO",
        "slogan": "Đam mê - Cháy hết mình trên từng đường cầu 🔥",
        "defaultCourt": "Sân cầu lông Tre Xanh (Sân 3 & 4)",
        "address": "50/1 Tân Sơn, Phường 15, Quận Tân Bình, TP. Hồ Chí Minh",
        "mapUrl": "https://maps.google.com/?q=San+Cau+Long+Tre+Xanh+Tan+Binh",
        "monthlyFee": 300000,
        "guestFee": 60000,
        "voteLockHours": 48,
        "autoApprove": False,
        "bank": {
            "bankId": "MB",
            "bankName": "MBBank - Ngân hàng Quân đội",
            "accountNo": "0988776655",
            "accountName": "NGUYEN VAN ADMIN",
            "qrTemplate": "compact"
        }
    },
    "users": [
        {
            "id": "user_admin",
            "username": "admin",
            "password": "admin",
            "name": "Quản trị viên CLB",
            "phone": "0988776655",
            "role": "admin",
            "memberId": "mem_admin",
            "type": "fixed",
            "avatar": "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
            "createdAt": "2026-09-01"
        }
    ],
    "members": [
        {
            "id": "mem_admin",
            "username": "admin",
            "name": "Quản trị viên CLB",
            "role": "admin",
            "phone": "0988776655",
            "type": "fixed",
            "avatar": "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
            "joinDate": "2026-09-01"
        }
    ],
    "sessions": [],
    "monthlyContributions": [],
    "transactions": [],
    "inventory": [
        {
            "id": "inv_1",
            "brand": "Hải Yến Đỏ Pro 77",
            "tubesInStock": 10,
            "pricePerTube": 230000,
            "lastRestocked": "2026-09-25",
            "shuttlesPerTube": 12
        }
    ]
}

def send_request(sheet_name, method="GET", payload=None):
    url = f"{CLOUD_URL}?sheet={urllib.parse.quote(sheet_name)}"
    print(f" -> [{method}] {url}")
    
    headers = {"Accept": "application/json"}
    data_bytes = None
    
    if method == "POST" and payload:
        headers["Content-Type"] = "text/plain;charset=utf-8"
        data_bytes = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        
    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            status_code = response.status
            content = response.read().decode('utf-8')
            print(f"    Status: {status_code} | Body: {content[:180]}")
            return status_code, content
    except Exception as e:
        print(f"    [!] Lỗi kết nối: {e}")
        return None, str(e)

def main():
    print("=" * 65)
    print("KHỞI TẠO CSDL VẬN HÀNH THỰC TẾ TRÊN GOOGLE DRIVE (SHEET PROD)")
    print("=" * 65)
    
    # 1. Đẩy CSDL Thực tế lên Sheet CSDL_VanHanh_Prod
    print("\n[1] Đẩy CSDL Thực tế (Tài khoản admin mặc định: admin/admin) lên Sheet 'CSDL_VanHanh_Prod'...")
    send_request("CSDL_VanHanh_Prod", method="POST", payload=PROD_DATABASE)
    
    # 2. Xác thực lại với GET
    print("\n[2] Xác thực lại CSDL Thực tế bằng lệnh GET...")
    send_request("CSDL_VanHanh_Prod", method="GET")
    
    print("\n[OK] Hoàn tất khởi tạo và kiểm thử CSDL Vận hành thực tế trên Cloud!")

if __name__ == "__main__":
    main()
