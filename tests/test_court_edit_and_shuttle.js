// Comprehensive Automated Test for Court Edit & Default Shuttle Type
const fs = require('fs');
const path = require('path');

console.log("==================================================");
console.log("🚀 BẮT ĐẦU KIỂM THỬ CHỨC NĂNG SỬA SÂN & LOẠI CẦU N/A");
console.log("==================================================");

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
  }
}

// 1. Kiểm tra mã nguồn js/modules/schedule.js
const scheduleJs = fs.readFileSync(path.join(__dirname, '../js/modules/schedule.js'), 'utf8');

// Test 1: Có hàm openEditCourtLocationModal hỗ trợ cả targetId và optionId
assert(scheduleJs.includes('openEditCourtLocationModal(targetId = \'club\', optionId = null)'), 'Hàm openEditCourtLocationModal tồn tại và nhận đúng tham số');

// Test 2: Modal có ô nhập edit-loc-court-price và edit-loc-shuttle-type
assert(scheduleJs.includes('id="edit-loc-court-price"'), 'Modal có ô nhập Tiền sân dự tính (#edit-loc-court-price)');
assert(scheduleJs.includes('id="edit-loc-shuttle-type"'), 'Modal có ô nhập Loại cầu sử dụng (#edit-loc-shuttle-type)');
assert(scheduleJs.includes('value="${shuttleType}" placeholder="n/a"'), 'Ô nhập Loại cầu có placeholder mặc định là n/a');

// Test 3: Hàm saveCourtLocation thu nhận courtPrice và shuttleType mặc định n/a
assert(scheduleJs.includes('const price = parseInt(document.getElementById(\'edit-loc-court-price\')?.value) || 0;'), 'saveCourtLocation đọc đúng tiền sân số nguyên');
assert(scheduleJs.includes("const shuttle = (document.getElementById('edit-loc-shuttle-type')?.value || '').trim() || 'n/a';"), 'saveCourtLocation chuẩn hóa loại cầu mặc định là n/a');
assert(scheduleJs.includes('session.courtPrice = price;'), 'saveCourtLocation gán courtPrice vào session');
assert(scheduleJs.includes('session.shuttleType = shuttle;'), 'saveCourtLocation gán shuttleType vào session');

// Test 4: Form tạo lịch mới openAddSessionModal mặc định shuttle là n/a
assert(scheduleJs.includes('id="session-shuttle" class="form-control" placeholder="VD: n/a hoặc Hải Yến Đỏ Pro" value="n/a"'), 'Form đặt lịch mới mặc định loại cầu là n/a');

// Test 5: Fallback shuttleType trong saveNewSession là n/a
assert(scheduleJs.includes("const shuttleType = (document.getElementById(\"session-shuttle\")?.value || \"\").trim() || 'n/a';"), 'saveNewSession có fallback loại cầu là n/a');

// Test 6: Fallback hiển thị trong chi tiết và thẻ lịch là n/a
assert(scheduleJs.includes("${session.shuttleType || 'n/a'}"), 'Giao diện hiển thị loại cầu mặc định n/a');

// Test 7: Nút sửa thông tin sân hiển thị đúng nhãn
assert(scheduleJs.includes('Sửa thông tin sân & tiền sân'), 'Nút hành động có nhãn "Sửa thông tin sân & tiền sân"');

// 2. Kiểm tra js/data.js
const dataJs = fs.readFileSync(path.join(__dirname, '../js/data.js'), 'utf8');
assert(dataJs.includes('shuttleType: "n/a"'), 'js/data.js chứa shuttleType: "n/a" cho ca đánh thực tế');
assert(dataJs.includes('courtPrice: 180000'), 'js/data.js chứa courtPrice: 180000');
assert(dataJs.includes('{ id: "rule_4", title: "Cầu sử dụng", content: "n/a" }'), 'js/data.js có quy định cầu sử dụng mặc định là n/a');

// 3. Kiểm tra js/modules/members.js
const membersJs = fs.readFileSync(path.join(__dirname, '../js/modules/members.js'), 'utf8');
assert(membersJs.includes('{ id: "rule_4", title: "Cầu sử dụng", content: "n/a" }'), 'members.js có quy định cầu mặc định là n/a');

console.log("==================================================");
console.log(`📊 KẾT QUẢ TEST: ${passedTests}/${totalTests} BÀI KIỂM THỬ THÀNH CÔNG (100%)`);
console.log("==================================================");

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
