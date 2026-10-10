# -*- coding: utf-8 -*-
import os
import sys
import json
import urllib.request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

print("=" * 70)
print("🚀 BẮT ĐẦU KIỂM THỬ BẢO MẬT ADMIN, BỎ NẠP TEST & NÚT SỬA ICON TINH GỌN")
print("=" * 70)

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

# 1. Kiểm tra css/components.css
with open(os.path.join(base_dir, 'css', 'components.css'), 'r', encoding='utf-8') as f:
    css_content = f.read()

assert_test(".admin-only {" in css_content and "display: none !important;" in css_content, 
            "CSS: .admin-only mặc định ẩn tuyệt đối (display: none !important)")
assert_test("body.is-admin .admin-only {" in css_content and "display: inline-flex !important;" in css_content,
            "CSS: Chỉ hiển thị .admin-only khi body có class .is-admin")
assert_test(".btn-icon.btn-xs" in css_content, "CSS: Có định nghĩa class nút icon siêu nhỏ .btn-icon.btn-xs")
assert_test(".btn-ghost" in css_content, "CSS: Có định nghĩa class nút không viền phẳng .btn-ghost")

# 2. Kiểm tra js/storage.js
with open(os.path.join(base_dir, 'js', 'storage.js'), 'r', encoding='utf-8') as f:
    storage_js = f.read()

assert_test("const isPlaceholder" not in storage_js, 
            "Storage: Đã loại bỏ hoàn toàn khối isPlaceholder tự động nhồi dữ liệu mẫu/test")
assert_test("parsed.clubInfo.name = PROD_DEFAULT_DATA.clubInfo.name;" in storage_js,
            "Storage: Chỉ đảm bảo cấu trúc tối thiểu, không ghi đè dữ liệu người dùng")
assert_test("isAdmin() {" in storage_js,
            "Storage: Có chốt chặn kiểm tra quyền Quản trị viên (isAdmin)")

# 3. Kiểm tra index.html (Banner Edit button)
with open(os.path.join(base_dir, 'index.html'), 'r', encoding='utf-8') as f:
    index_html = f.read()

assert_test('class="btn btn-icon btn-xs admin-only"' in index_html,
            "HTML: Nút sửa banner trên Hero Banner đã tinh gọn dạng icon nhỏ với class admin-only")
assert_test('<span>Sửa banner</span>' not in index_html,
            "HTML: Đã gỡ bỏ chữ 'Sửa banner' cồng kềnh khỏi Hero Banner")

# 4. Kiểm tra js/modules/schedule.js
with open(os.path.join(base_dir, 'js', 'modules', 'schedule.js'), 'r', encoding='utf-8') as f:
    schedule_js = f.read()

assert_test("ScheduleModule.openEditCourtLocationModal('${session.id}')\" title=\"Admin: Chỉnh sửa thông tin sân, tiền sân & loại cầu\" style=\"border: 1px solid var(--border-color); border-radius: var(--radius-sm);\"" in schedule_js,
            "Schedule: Nút sửa thông tin sân trong Modal chi tiết ca đánh đã tinh gọn dạng icon .btn-icon")
assert_test("onclick=\"event.stopPropagation(); ScheduleModule.openEditCourtLocationModal('${session.id}')\" title=\"Admin: Chỉnh sửa thông tin sân & tiền sân\" style=\"border: 1px solid var(--border-color); border-radius: var(--radius-sm); margin-left: 0.35rem; flex-shrink: 0;\"" in schedule_js,
            "Schedule: Nút sửa sân trên thẻ ca đánh đã tinh gọn dạng icon .btn-icon.btn-xs")
assert_test("ScheduleModule.openEditCourtLocationModal('${session.id}', '${opt.id}')\" title=\"Admin: Sửa thông tin sân & tiền sân phương án này\" style=\"border: 1px solid var(--border-color); border-radius: var(--radius-sm);\"" in schedule_js,
            "Schedule: Nút sửa sân trong phương án khảo sát đã tinh gọn dạng icon")

# 5. Kiểm tra js/modules/voting.js
with open(os.path.join(base_dir, 'js', 'modules', 'voting.js'), 'r', encoding='utf-8') as f:
    voting_js = f.read()

assert_test("ScheduleModule.openEditCourtLocationModal('${session.id}', '${opt.id}')\" title=\"Admin: Sửa thông tin sân & tiền sân phương án này\"" in voting_js,
            "Voting: Nút sửa sân phương án trong module Voting đã tinh gọn dạng icon")
assert_test("ScheduleModule.openEditCourtLocationModal('${session.id}')\" title=\"Admin: Sửa thông tin sân & tiền sân\"" in voting_js,
            "Voting: Nút sửa sân ca đơn trong module Voting đã tinh gọn dạng icon")

# 6. Kiểm tra js/modules/settings.js
with open(os.path.join(base_dir, 'js', 'modules', 'settings.js'), 'r', encoding='utf-8') as f:
    settings_js = f.read()

assert_test("ScheduleModule.openEditCourtLocationModal('club')\" title=\"Admin: Sửa vị trí & bản đồ sân nhà\"" in settings_js,
            "Settings: Nút sửa sân nhà trong cài đặt đã tinh gọn dạng icon")

# 7. Kiểm tra js/app.js
with open(os.path.join(base_dir, 'js', 'app.js'), 'r', encoding='utf-8') as f:
    app_js = f.read()

assert_test("document.body.classList.toggle('is-admin', isAdmin);" in app_js,
            "App: updateAdminUI tự động gắn class .is-admin lên body theo vai trò đăng nhập")

print("=" * 70)
print(f"📊 KẾT QUẢ TEST: {passed_tests}/{total_tests} BÀI KIỂM THỬ THÀNH CÔNG ({int(passed_tests/total_tests*100)}%)")
print("=" * 70)

if passed_tests == total_tests:
    sys.exit(0)
else:
    sys.exit(1)
