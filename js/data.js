// Dữ liệu ban đầu mặc định cho môi trường Vận hành Thực tế (Production Clean Database)
// Tuyệt đối KHÔNG chứa dữ liệu mẫu/giả định/bịa đặt
const PROD_DEFAULT_DATA = {
  version: "2.6_PROD",
  sheetName: "CSDL_VanHanh_Prod",
  lastModified: 1790503000000,

  // Thông tin CLB & Tài khoản ngân hàng thực tế
  clubInfo: {
    name: "CLB trẻ không chơi già đổ đốn",
    shortName: "GDD",
    season: "Mùa giải 2026",
    description: "Câu lạc bộ cầu lông giao lưu phong trào & rèn luyện thể chất.",
    logo: "assets/badminton-logo.svg",
    defaultCourt: "",
    address: "",
    bannerSubtitle: "",
    mapUrl: "",
    monthlyFundFee: 20000,
    monthlyFee: 20000,
    guestFee: 5000,
    voteLockHours: 48,
    bank: {
      bankId: "MBBank",
      accountNo: "29999439999",
      accountName: "D",
      qrTemplate: "compact2"
    },
    benefitsAndRules: [
      { id: "rule_1", title: "Quyền lợi thành viên cố định", content: "Tham gia mọi buổi đánh định kỳ và hưởng quyền lợi thành viên trọn gói." },
      { id: "rule_2", title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
      { id: "rule_3", title: "Quỹ sân minh bạch", content: "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
      { id: "rule_4", title: "Cầu sử dụng", content: "n/a" }
    ]
  },

  // Danh sách tài khoản đăng nhập hệ thống thực tế (3 tài khoản thực tế)
  users: [
    { 
      id: "user_admin", 
      username: "admin", 
      password: "$sha256$8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918", 
      name: "Quản trị viên CLB", 
      phone: "0988776655", 
      email: "admin.vip@smashpro.vn", 
      note: "Chủ nhiệm CLB - Trình độ A1", 
      role: "admin", 
      memberId: "mem_admin", 
      type: "fixed", 
      avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80", 
      themePreference: "light", 
      createdAt: "2026-09-01" 
    },
    { 
      id: "user_1790477884866", 
      username: "quanghien09", 
      password: "$sha256$ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f", 
      name: "Đặng Quang Hiển", 
      phone: "0938888888", 
      role: "member", 
      memberId: "mem_1790477884866", 
      type: "fixed", 
      avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80", 
      themePreference: "light", 
      createdAt: "2026-09-27T02:58:04.866Z" 
    },
    { 
      id: "user_1790484049597", 
      username: "huavihieu", 
      password: "$sha256$4b832360d3f07f6454db136f0dc65f463a69295a19e6248127750bc8a011181e", 
      name: "Hứa Vĩ Vi Hiếu", 
      phone: "0393093366", 
      email: "huavihieu@gmail.com", 
      note: "mắc cỡ", 
      role: "member", 
      memberId: "mem_1790484049597", 
      type: "fixed", 
      avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80", 
      themePreference: "light", 
      createdAt: "2026-09-27T04:40:49.597Z" 
    }
  ],

  currentUser: null,

  // Danh sách thành viên CLB thực tế (3 thành viên thực tế)
  members: [
    { 
      id: "mem_admin", 
      username: "admin", 
      name: "Quản trị viên CLB", 
      phone: "0988776655", 
      email: "admin.vip@smashpro.vn", 
      note: "Chủ nhiệm CLB - Trình độ A1", 
      type: "fixed", 
      role: "admin", 
      avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80", 
      joinDate: "2026-09-01" 
    },
    { 
      id: "mem_1790477884866", 
      username: "quanghien09", 
      name: "Đặng Quang Hiển", 
      phone: "0938888888", 
      role: "member", 
      type: "fixed", 
      avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80", 
      joinDate: "2026-09-27" 
    },
    { 
      id: "mem_1790484049597", 
      username: "huavihieu", 
      name: "Hứa Vĩ Vi Hiếu", 
      phone: "0393093366", 
      email: "huavihieu@gmail.com", 
      note: "mắc cỡ", 
      role: "member", 
      type: "fixed", 
      avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80", 
      joinDate: "2026-09-27" 
    }
  ],

  // Danh sách ca đánh: Rỗng (người dùng tự tạo theo nhu cầu thực tế)
  sessions: [],

  // Danh sách đóng quỹ tháng: Ban đầu unpaid cho 3 thành viên thực tế
  monthlyContributions: [
    { id: "due_2026-09_mem_admin", month: "2026-09", memberId: "mem_admin", amount: 20000, status: "unpaid", paidAt: null, note: "Chưa đóng" },
    { id: "due_2026-09_mem_1790477884866", month: "2026-09", memberId: "mem_1790477884866", amount: 20000, status: "unpaid", paidAt: null, note: "Chưa đóng" },
    { id: "due_2026-09_mem_1790484049597", month: "2026-09", memberId: "mem_1790484049597", amount: 20000, status: "unpaid", paidAt: null, note: "Chưa đóng" }
  ],

  // Sổ thu chi: Rỗng (Số dư quỹ: 0 đ)
  transactions: [],

  // Kho cầu: Rỗng
  inventory: []
};
