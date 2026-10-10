import requests
import json
import time
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

CLOUD_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec?sheet=CSDL_VanHanh_Prod"

def sync_pure_prod():
    # CSDL thực tế thuần túy - Tuyệt đối không chứa dữ liệu mẫu / bịa đặt
    clean_data = {
        "version": "2.6_PROD",
        "sheetName": "CSDL_VanHanh_Prod",
        "lastModified": int(time.time() * 1000),
        "isInitialSkeleton": False,
        "mode": "production",
        "clubInfo": {
            "name": "CLB trẻ không chơi già đổ đốn",
            "shortName": "GDD",
            "season": "Mùa giải 2026",
            "description": "Câu lạc bộ cầu lông giao lưu phong trào & rèn luyện thể chất.",
            "logo": "assets/badminton-logo.svg",
            "defaultCourt": "",
            "address": "",
            "bannerSubtitle": "",
            "mapUrl": "",
            "monthlyFundFee": 20000,
            "monthlyFee": 20000,
            "guestFee": 5000,
            "voteLockHours": 48,
            "bank": {
                "bankId": "MBBank",
                "accountNo": "29999439999",
                "accountName": "D",
                "qrTemplate": "compact2"
            },
            "benefitsAndRules": [
                { "id": "rule_1", "title": "Quyền lợi thành viên cố định", "content": "Tham gia mọi buổi đánh định kỳ và hưởng quyền lợi thành viên trọn gói." },
                { "id": "rule_2", "title": "Tự động đóng vote 2 ngày", "content": "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
                { "id": "rule_3", "title": "Quỹ sân minh bạch", "content": "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
                { "id": "rule_4", "title": "Cầu sử dụng", "content": "n/a" }
            ]
        },
        "users": [
            {
                "id": "user_admin",
                "username": "admin",
                "password": "$sha256$8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918",
                "name": "Quản trị viên CLB",
                "phone": "0988776655",
                "email": "admin.vip@smashpro.vn",
                "note": "Chủ nhiệm CLB - Trình độ A1",
                "role": "admin",
                "memberId": "mem_admin",
                "type": "fixed",
                "avatar": "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80",
                "themePreference": "light",
                "createdAt": "2026-09-01"
            },
            {
                "id": "user_1790477884866",
                "username": "quanghien09",
                "password": "$sha256$ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f",
                "name": "Đặng Quang Hiển",
                "phone": "0938888888",
                "role": "member",
                "memberId": "mem_1790477884866",
                "type": "fixed",
                "avatar": "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
                "themePreference": "light",
                "createdAt": "2026-09-27T02:58:04.866Z"
            },
            {
                "id": "user_1790484049597",
                "username": "huavihieu",
                "password": "$sha256$4b832360d3f07f6454db136f0dc65f463a69295a19e6248127750bc8a011181e",
                "name": "Hứa Vĩ Vi Hiếu",
                "phone": "0393093366",
                "email": "huavihieu@gmail.com",
                "note": "mắc cỡ",
                "role": "member",
                "memberId": "mem_1790484049597",
                "type": "fixed",
                "avatar": "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80",
                "themePreference": "light",
                "createdAt": "2026-09-27T04:40:49.597Z"
            }
        ],
        "currentUser": None,
        "members": [
            {
                "id": "mem_admin",
                "username": "admin",
                "name": "Quản trị viên CLB",
                "phone": "0988776655",
                "email": "admin.vip@smashpro.vn",
                "note": "Chủ nhiệm CLB - Trình độ A1",
                "type": "fixed",
                "role": "admin",
                "avatar": "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80",
                "joinDate": "2026-09-01"
            },
            {
                "id": "mem_1790477884866",
                "username": "quanghien09",
                "name": "Đặng Quang Hiển",
                "phone": "0938888888",
                "role": "member",
                "type": "fixed",
                "avatar": "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
                "joinDate": "2026-09-27"
            },
            {
                "id": "mem_1790484049597",
                "username": "huavihieu",
                "name": "Hứa Vĩ Vi Hiếu",
                "phone": "0393093366",
                "email": "huavihieu@gmail.com",
                "note": "mắc cỡ",
                "role": "member",
                "type": "fixed",
                "avatar": "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80",
                "joinDate": "2026-09-27"
            }
        ],
        "sessions": [],
        "monthlyContributions": [
            { "id": "due_2026-09_mem_admin", "month": "2026-09", "memberId": "mem_admin", "amount": 20000, "status": "unpaid", "paidAt": None, "note": "Chưa đóng" },
            { "id": "due_2026-09_mem_1790477884866", "month": "2026-09", "memberId": "mem_1790477884866", "amount": 20000, "status": "unpaid", "paidAt": None, "note": "Chưa đóng" },
            { "id": "due_2026-09_mem_1790484049597", "month": "2026-09", "memberId": "mem_1790484049597", "amount": 20000, "status": "unpaid", "paidAt": None, "note": "Chưa đóng" }
        ],
        "transactions": [],
        "inventory": [],
        "deletedMemberIds": [
            "mem_maianh", "mem_hoanglong", "mem_minhduc", "mem_thaovy", "mem_giahuy",
            "mem_thanhson", "mem_tuyetnhi", "mem_tuankiet", "mem_baohung", "mem_1790412027160",
            "mem_1790414367290", "mem_vanhau", "mem_regular", "mem_audit_user", "mem_quanghien",
            "mem_vihieu", "mem_tuannv", "mem_1790479550427"
        ],
        "deletedUserIds": [
            "user_maianh", "user_hoanglong", "user_minhduc", "user_thaovy", "user_giahuy",
            "user_thanhson", "user_tuyetnhi", "user_tuankiet", "user_baohung", "user_dcatrus",
            "user_baonam", "user_vanhau", "user_regular", "u_regular", "user_audit_1",
            "user_quanghien", "user_vihieu", "user_tuannv", "user_1790479550427",
            "maianh", "hoanglong", "minhduc", "thaovy", "giahuy", "thanhson", "tuyetnhi",
            "tuankiet", "baohung", "dcatrus", "baonam", "vanhau", "quanghien", "vihieu",
            "tuannv", "0912345678", "test_garbage", "thanhvien1"
        ]
    }

    payload_str = json.dumps(clean_data, ensure_ascii=False)
    headers = {"Content-Type": "text/plain;charset=utf-8"}

    print("Pushing clean real-only database to Google Cloud Prod...")
    resp = requests.post(CLOUD_URL, data=payload_str.encode('utf-8'), headers=headers, timeout=25)
    print(f"Status: {resp.status_code}")
    print(f"Response: {resp.text}")

if __name__ == "__main__":
    sync_pure_prod()
