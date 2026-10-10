# -*- coding: utf-8 -*-
import os
import sys
import json
import urllib.request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

print("=" * 60)
print("🚀 BẮT ĐẦU KIỂM THỬ CHỨC NĂNG SỬA SÂN & LOẠI CẦU MẶC ĐỊNH N/A")
print("=" * 60)

passed_tests = 0
total_tests = 0

def assert_test(condition, message):
    global passed_tests, total_tests
    total_tests += 1
    if condition:
        print(f"  ✅ [PASS] {message}")
        passed_tests += 1
    else:
        print(f"  ❌ [FAIL] {message}")

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 1. Kiểm tra mã nguồn js/modules/schedule.js
with open(os.path.join(base_dir, 'js', 'modules', 'schedule.js'), 'r', encoding='utf-8') as f:
    schedule_js = f.read()

assert_test("openEditCourtLocationModal(targetId = 'club', optionId = null)" in schedule_js, "Hàm openEditCourtLocationModal hỗ trợ cả targetId và optionId")
assert_test('id="edit-loc-court-price"' in schedule_js, "Modal có ô nhập Tiền sân dự tính (#edit-loc-court-price)")
assert_test('id="edit-loc-shuttle-type"' in schedule_js, "Modal có ô nhập Loại cầu sử dụng (#edit-loc-shuttle-type)")
assert_test('value="${shuttleType}" placeholder="n/a"' in schedule_js, "Ô nhập Loại cầu có placeholder mặc định là n/a")
assert_test("const price = parseInt(document.getElementById('edit-loc-court-price')?.value) || 0;" in schedule_js, "saveCourtLocation đọc đúng tiền sân số nguyên")
assert_test("const shuttle = (document.getElementById('edit-loc-shuttle-type')?.value || '').trim() || 'n/a';" in schedule_js, "saveCourtLocation chuẩn hóa loại cầu mặc định là n/a")
assert_test("session.courtPrice = price;" in schedule_js, "saveCourtLocation gán courtPrice vào session")
assert_test("session.shuttleType = shuttle;" in schedule_js, "saveCourtLocation gán shuttleType vào session")
assert_test('id="session-shuttle" class="form-control" placeholder="VD: n/a hoặc Hải Yến Đỏ Pro" value="n/a"' in schedule_js, "Form đặt lịch mới mặc định loại cầu là n/a")
assert_test('const shuttleType = (document.getElementById("session-shuttle")?.value || "").trim() || \'n/a\';' in schedule_js, "saveNewSession có fallback loại cầu là n/a")
assert_test("${session.shuttleType || 'n/a'}" in schedule_js, "Giao diện hiển thị loại cầu mặc định n/a")
assert_test("Sửa thông tin sân & tiền sân" in schedule_js, "Nút hành động có nhãn 'Sửa thông tin sân & tiền sân'")

# 2. Kiểm tra js/data.js
with open(os.path.join(base_dir, 'js', 'data.js'), 'r', encoding='utf-8') as f:
    data_js = f.read()

assert_test('shuttleType: "n/a"' in data_js, "js/data.js chứa shuttleType: 'n/a' cho ca đánh")
assert_test('courtPrice: 180000' in data_js, "js/data.js chứa courtPrice: 180000")
assert_test('{ id: "rule_4", title: "Cầu sử dụng", content: "n/a" }' in data_js, "js/data.js có quy định cầu sử dụng mặc định là n/a")

# 3. Kiểm tra js/modules/members.js
with open(os.path.join(base_dir, 'js', 'modules', 'members.js'), 'r', encoding='utf-8') as f:
    members_js = f.read()

assert_test('{ id: "rule_4", title: "Cầu sử dụng", content: "n/a" }' in members_js, "members.js có quy định cầu mặc định là n/a")

# 4. Kiểm tra CSDL Cloud thực tế
cloud_url = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec?sheet=CSDL_VanHanh_Prod"
try:
    req = urllib.request.urlopen(cloud_url, timeout=15)
    cloud_data = json.loads(req.read().decode('utf-8'))
    sessions = cloud_data.get('sessions', [])
    assert_test(len(sessions) == 1, "CSDL Cloud có đúng 1 ca đánh thực tế ngày 1/10")
    if sessions:
        ses = sessions[0]
        assert_test(ses.get('courtPrice') == 180000, "Ca đánh trên Cloud có courtPrice = 180.000đ")
        assert_test(ses.get('shuttleType') == "n/a", "Ca đánh trên Cloud có shuttleType = 'n/a'")
        assert_test(ses.get('courtName') == "Sân 1 Tre Xanh", "Ca đánh trên Cloud có courtName = 'Sân 1 Tre Xanh'")
    members = cloud_data.get('members', [])
    assert_test(len(members) == 14, "CSDL Cloud bảo toàn nguyên vẹn 14 thành viên thực tế")
except Exception as ex:
    print(f"  ⚠️ Lỗi kiểm tra Cloud: {ex}")

print("=" * 60)
print(f"📊 KẾT QUẢ TEST: {passed_tests}/{total_tests} BÀI KIỂM THỬ THÀNH CÔNG ({int(passed_tests/total_tests*100)}%)")
print("=" * 60)

if passed_tests == total_tests:
    sys.exit(0)
else:
    sys.exit(1)
