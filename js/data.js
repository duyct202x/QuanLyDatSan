// Database Structure for SMASH PRO Badminton Management System
// Hỗ trợ chế độ Vận hành thực tế (Production) & Chế độ Dữ liệu thử nghiệm (Test Demo)

// 1. CSDL VẬN HÀNH THỰC TẾ (PRODUCTION DATABASE)
const PROD_DEFAULT_DATA = {
  version: "2.7_PROD",
  mode: "production",
  clubInfo: {
    name: "SMASH PRO Badminton Club",
    shortName: "SMASH PRO",
    slogan: "Đam mê - Cháy hết mình trên từng đường cầu 🔥",
    season: "Mùa giải 2026",
    bannerSubtitle: "Sân cầu lông Tre Xanh (Sân 3 & 4) • Tự động đóng vote trước giờ đánh 2 ngày",
    defaultCourt: "Sân cầu lông Tre Xanh (Sân 3 & 4)",
    address: "50/1 Tân Sơn, Phường 15, Quận Tân Bình, TP. Hồ Chí Minh",
    mapUrl: "https://maps.google.com/?q=San+Cau+Long+Tre+Xanh+Tan+Binh",
    monthlyFee: 300000, // 300k VNĐ / tháng
    guestFee: 60000,    // 60k VNĐ / buổi
    voteLockHours: 48,  // Tự động đóng vote trước 2 ngày (48 giờ)
    autoApprove: false, // Mặc định duyệt qua ban quản trị / thủ quỹ
    bank: {
      bankId: "MB",
      bankName: "MBBank - Ngân hàng Quân đội",
      accountNo: "0988776655",
      accountName: "NGUYEN VAN ADMIN",
      qrTemplate: "compact"
    },
    benefitsAndRules: [
      { id: "rule_1", title: "Lịch đánh cố định", content: "Thứ 7 (18h-20h) và Thứ 3 (19h30-21h30) tại sân Tre Xanh." },
      { id: "rule_2", title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
      { id: "rule_3", title: "Quỹ sân minh bạch", content: "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
      { id: "rule_4", title: "Cầu sử dụng", content: "Cầu Hải Yến Đỏ Pro & Ba Sao Pro tiêu chuẩn thi đấu." }
    ]
  },

  // Danh sách tài khoản đăng nhập hệ thống (Mặc định: Chỉ có tài khoản Quản trị viên)
  users: [
    {
      id: "user_admin",
      username: "admin",
      password: "admin",
      name: "Quản trị viên CLB",
      phone: "0988776655",
      email: "admin@smashpro.vn",
      note: "Chủ nhiệm CLB - Trình độ A1",
      role: "admin",
      memberId: "mem_admin",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
      themePreference: "light",
      createdAt: "2026-09-01"
    }
  ],

  currentUser: null,

  // Danh sách thành viên CLB vận hành thực tế (Mặc định: Chỉ có Admin, thành viên thật do người dùng đăng ký hoặc thêm mới)
  members: [
    {
      id: "mem_admin",
      username: "admin",
      name: "Quản trị viên CLB",
      phone: "0988776655",
      email: "admin@smashpro.vn",
      note: "Chủ nhiệm CLB - Trình độ A1",
      type: "fixed",
      role: "admin",
      avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
      joinDate: "2026-09-01"
    }
  ],

  // Danh sách ca đánh thực tế (Mặc định: Trống - Ban quản trị tự tạo lịch thực tế)
  sessions: [],

  // Danh sách đóng quỹ tháng thực tế (Mặc định: Trống - Tự động phát sinh khi có thành viên cố định)
  monthlyContributions: [],

  // Sổ thu chi quỹ CLB thực tế (Mặc định: Trống - Số dư 0đ, chỉ ghi nhận khi Admin tạo giao dịch thực tế)
  transactions: [],

  // Kho cầu CLB thực tế
  inventory: []
};

// 2. CSDL MẪU DÀNH CHO KIỂM THỬ GIAO DIỆN (TEST DEMO DATABASE)
const TEST_MOCK_DATA = {
  version: "2.0_TEST",
  mode: "test",
  clubInfo: {
    name: "SMASH PRO Badminton Club (Test Demo)",
    shortName: "SMASH TEST",
    slogan: "Dữ liệu mẫu kiểm thử giao diện",
    season: "Mùa giải 2026",
    bannerSubtitle: "Sân cầu lông Tre Xanh (Sân 3 & 4)",
    defaultCourt: "Sân cầu lông Tre Xanh (Sân 3 & 4)",
    address: "50/1 Tân Sơn, Phường 15, Quận Tân Bình, TP. Hồ Chí Minh",
    mapUrl: "https://maps.google.com/?q=San+Cau+Long+Tre+Xanh+Tan+Binh",
    monthlyFee: 300000,
    guestFee: 60000,
    voteLockHours: 48,
    autoApprove: false,
    bank: {
      bankId: "MB",
      bankName: "MBBank - Ngân hàng Quân đội",
      accountNo: "0988776655",
      accountName: "NGUYEN VAN ADMIN",
      qrTemplate: "compact"
    },
    benefitsAndRules: [
      { id: "rule_1", title: "Lịch đánh cố định", content: "Thứ 7 (18h-20h) và Thứ 3 (19h30-21h30) tại sân Tre Xanh." },
      { id: "rule_2", title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." }
    ]
  },
  users: [
    { id: "user_admin", username: "admin", password: "admin", name: "Quản trị viên CLB", phone: "0988776655", role: "admin", memberId: "mem_admin", type: "fixed", avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80" },
    { id: "user_maianh", username: "maianh", password: "password123", name: "Trần Mai Anh (Thủ quỹ)", phone: "0912345678", role: "treasurer", memberId: "mem_maianh", type: "fixed", avatar: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80" },
    { id: "user_hoanglong", username: "hoanglong", password: "password123", name: "Lê Hoàng Long", phone: "0908889991", role: "member", memberId: "mem_hoanglong", type: "fixed", avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80" }
  ],
  members: [
    { id: "mem_admin", username: "admin", name: "Quản trị viên CLB", phone: "0988776655", type: "fixed", role: "admin", avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80", joinDate: "2026-09-01" },
    { id: "mem_maianh", username: "maianh", name: "Trần Mai Anh (Thủ quỹ)", phone: "0912345678", type: "fixed", role: "treasurer", avatar: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80", joinDate: "2026-09-01" },
    { id: "mem_hoanglong", username: "hoanglong", name: "Lê Hoàng Long", phone: "0908889991", type: "fixed", role: "member", avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80", joinDate: "2026-09-01" }
  ],
  sessions: [],
  monthlyContributions: [],
  transactions: [],
  inventory: []
};

// Mặc định nạp CSDL Vận hành thực tế (Production)
const DEFAULT_DATA = PROD_DEFAULT_DATA;
