# Tài Nguyên Đầu Vào: Yêu Cầu & Cấu Hình Dự Án

## 1. Mục Đích Thư Mục `resources/inputs/`
Thư mục này chứa toàn bộ các thông tin đầu vào phục vụ cho quá trình phát triển, tích hợp và kiểm thử hệ thống phần mềm SMASH PRO, bao gồm:
- Đặc tả yêu cầu người dùng (User Requirements & Use Cases)
- Cấu hình kết nối dịch vụ ngoài (API Endpoints, Cloud Config)
- Dữ liệu khởi tạo mẫu (Initial Mock Data, Danh sách thành viên, Lịch sân mẫu)

## 2. Thông Tin Cấu Hình Cloud Hiện Tại
- **Hệ thống Cloud Backend**: Google Apps Script Web App
- **Endpoint URL**: `https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec`
- **Cơ chế hoạt động**:
  - Hỗ trợ gọi API `GET` để tải toàn bộ danh sách đặt sân, điểm danh và danh sách vote.
  - Hỗ trợ gọi API `POST` (với chế độ `no-cors` / JSON payload) để lưu trữ tức thời lên Google Sheets trên Google Drive.

## 3. Danh Mục Tính Năng Trọng Tâm
1. **Quản lý đặt sân**: Đặt sân theo ca cố định và vãng lai, tự động tính tiền và chia đều chi phí.
2. **Hệ thống bình chọn (Vote)**: Lựa chọn linh hoạt giữa các sân và khung giờ khác nhau, hỗ trợ phân loại cố định / vãng lai.
3. **Điểm danh tự động & Quản lý thu chi**: Theo dõi số người tham gia thực tế, cập nhật số dư quỹ câu lạc bộ.
4. **Giao diện đa nền tảng**: Tự động co giãn tối ưu cho máy tính, máy tính bảng và điện thoại di động.
