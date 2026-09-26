// Database Structure for SMASH PRO Badminton Management System
// Hỗ trợ chế độ Vận hành thực tế (Production) & Chế độ Dữ liệu thử nghiệm (Test Demo)

// 1. CSDL VẬN HÀNH THỰC TẾ (PRODUCTION DATABASE)
const PROD_DEFAULT_DATA = {
  version: "2.1_PROD",
  mode: "production",
  clubInfo: {
    name: "SMASH PRO Badminton Club",
    shortName: "SMASH PRO",
    slogan: "Đam mê - Cháy hết mình trên từng đường cầu 🔥",
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
    }
  },

  // Danh sách tài khoản đăng nhập hệ thống
  // Tài khoản Admin mặc định: username="admin", password="admin"
  users: [
    {
      id: "user_admin",
      username: "admin",
      password: "admin",
      name: "Quản trị viên CLB",
      phone: "0988776655",
      role: "admin", // admin | treasurer | member
      memberId: "mem_admin",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
      createdAt: "2026-09-01"
    }
  ],

  currentUser: null,

  // Danh sách thành viên CLB vận hành thực tế (Mặc định trống để CLB tự thêm/đăng ký thành viên thật)
  members: [],

  // Danh sách các ca đặt sân & khảo sát vote thực tế
  sessions: [
    {
      id: "ses_1",
      title: "Giao lưu cầu lông thứ 7 sôi động",
      sessionType: "fixed",
      voteMode: "standard",
      date: "2026-09-27",
      startTime: "18:00",
      endTime: "20:00",
      courtName: "Sân cầu lông Tre Xanh",
      courtNumbers: "Sân 3 & Sân 4 (2 sân)",
      courtPrice: 360000,
      shuttleType: "Hải Yến Đỏ Pro (Tốc độ 77)",
      maxPlayers: 12,
      note: "Khởi động kỹ lúc 17:50, mang giày đế cao su không để lại vết!",
      status: "open",
      votes: []
    },
    {
      id: "ses_poll_1",
      title: "Khảo sát chọn sân & khung giờ giao lưu thứ 5",
      sessionType: "guest",
      voteMode: "multi_option",
      date: "2026-10-01",
      startTime: "18:00",
      endTime: "20:00",
      courtName: "Đang bình chọn phương án",
      courtNumbers: "2 sân",
      courtPrice: 360000,
      shuttleType: "Hải Yến Đỏ Pro",
      maxPlayers: 12,
      note: "Anh em vote chọn phương án sân và khung giờ phù hợp nhất để chốt nhé!",
      status: "open",
      options: [
        {
          id: "opt_1",
          courtName: "Sân cầu lông Tre Xanh (Tân Bình)",
          courtNumbers: "Sân 3 & 4 (2 sân)",
          date: "2026-10-01",
          startTime: "18:00",
          endTime: "20:00",
          price: 360000,
          note: "Khung giờ sớm, gần trung tâm Tân Bình"
        },
        {
          id: "opt_2",
          courtName: "Sân cầu lông Viettel (Hoàng Hoa Thám)",
          courtNumbers: "Sân 1 & 2 (2 sân)",
          date: "2026-10-01",
          startTime: "19:30",
          endTime: "21:30",
          price: 380000,
          note: "Khung giờ muộn, thảm mới 100% chuẩn thi đấu"
        }
      ],
      selectedOptionId: null,
      votes: []
    }
  ],

  // Danh sách đóng quỹ tháng thực tế
  monthlyContributions: [],

  // Sổ thu chi quỹ CLB thực tế
  transactions: [],

  // Kho cầu CLB thực tế
  inventory: [
    {
      id: "inv_1",
      brand: "Hải Yến Đỏ Pro 77",
      tubesInStock: 10,
      pricePerTube: 230000,
      lastRestocked: "2026-09-25",
      shuttlesPerTube: 12
    }
  ]
};

// 2. CSDL MẪU DÀNH CHO ADMIN KIỂM THỬ (TEST DEMO DATABASE)
const TEST_MOCK_DATA = {
  version: "2.0_TEST",
  mode: "test",
  clubInfo: {
    name: "SMASH PRO Badminton Club (Test Demo)",
    shortName: "SMASH PRO TEST",
    slogan: "Đam mê - Cháy hết mình trên từng đường cầu 🔥",
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
    }
  },

  users: [
    {
      id: "user_admin",
      username: "admin",
      password: "admin",
      name: "Nguyễn Văn Admin",
      phone: "0988776655",
      role: "admin",
      memberId: "mem_1",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
      createdAt: "2024-01-15"
    },
    {
      id: "user_mem2",
      username: "maianh",
      password: "password123",
      name: "Trần Mai Anh (Thủ quỹ)",
      phone: "0912345678",
      role: "treasurer",
      memberId: "mem_2",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80",
      createdAt: "2024-02-01"
    }
  ],

  members: [
    {
      id: "mem_1",
      username: "admin",
      name: "Nguyễn Văn Admin",
      role: "admin",
      phone: "0988776655",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-01-15"
    },
    {
      id: "mem_2",
      username: "maianh",
      name: "Trần Mai Anh (Thủ quỹ)",
      role: "treasurer",
      phone: "0912345678",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-02-01"
    },
    {
      id: "mem_3",
      username: "hoanglong",
      name: "Lê Hoàng Long",
      role: "member",
      phone: "0908889991",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-03-10"
    },
    {
      id: "mem_4",
      username: "minhduc",
      name: "Phạm Minh Đức",
      role: "member",
      phone: "0933221144",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-03-15"
    },
    {
      id: "mem_5",
      username: "thaovy",
      name: "Hoàng Thảo Vy",
      role: "member",
      phone: "0977665544",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-04-01"
    },
    {
      id: "mem_6",
      username: "giahuy",
      name: "Đỗ Gia Huy",
      role: "member",
      phone: "0981122334",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-04-12"
    },
    {
      id: "mem_7",
      username: "thanhson",
      name: "Vũ Thanh Sơn",
      role: "member",
      phone: "0903344556",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-05-20"
    },
    {
      id: "mem_8",
      username: "tuyetnhi",
      name: "Bùi Tuyết Nhi",
      role: "member",
      phone: "0938776611",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-06-01"
    },
    {
      id: "mem_9",
      username: "tuankiet",
      name: "Đặng Tuấn Kiệt",
      role: "member",
      phone: "0944556677",
      type: "fixed",
      avatar: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-06-15"
    },
    {
      id: "mem_10",
      username: "baohung",
      name: "Trịnh Bảo Hưng",
      role: "member",
      phone: "0911223399",
      type: "guest",
      avatar: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&auto=format&fit=crop&q=80",
      joinDate: "2024-07-01"
    }
  ],

  sessions: [
    {
      id: "ses_1",
      title: "Giao lưu cầu lông thứ 7 sôi động",
      sessionType: "fixed",
      voteMode: "standard",
      date: "2026-09-27",
      startTime: "18:00",
      endTime: "20:00",
      courtName: "Sân cầu lông Tre Xanh",
      courtNumbers: "Sân 3 & Sân 4 (2 sân)",
      courtPrice: 360000,
      shuttleType: "Hải Yến Đỏ Pro (Tốc độ 77)",
      maxPlayers: 12,
      note: "Khởi động kỹ lúc 17:50, mang giày đế cao su không để lại vết!",
      status: "open",
      votes: [
        { memberId: "mem_1", status: "going", guests: 0, votedAt: "2026-09-24 10:00" },
        { memberId: "mem_2", status: "going", guests: 1, votedAt: "2026-09-24 11:30" },
        { memberId: "mem_3", status: "going", guests: 0, votedAt: "2026-09-24 14:15" },
        { memberId: "mem_4", status: "going", guests: 0, votedAt: "2026-09-24 15:20" },
        { memberId: "mem_6", status: "going", guests: 0, votedAt: "2026-09-24 16:40" },
        { memberId: "mem_7", status: "going", guests: 0, votedAt: "2026-09-24 17:00" },
        { memberId: "mem_5", status: "not_going", guests: 0, note: "Bận việc gia đình", votedAt: "2026-09-24 12:00" },
        { memberId: "mem_8", status: "maybe", guests: 0, votedAt: "2026-09-24 18:10" }
      ]
    },
    {
      id: "ses_poll_1",
      title: "Khảo sát chọn sân & khung giờ giao lưu thứ 5",
      sessionType: "guest",
      voteMode: "multi_option",
      date: "2026-10-01",
      startTime: "18:00",
      endTime: "20:00",
      courtName: "Đang bình chọn phương án",
      courtNumbers: "2 sân",
      courtPrice: 360000,
      shuttleType: "Hải Yến Đỏ Pro",
      maxPlayers: 12,
      note: "Anh em vote chọn phương án sân và khung giờ phù hợp nhất để chốt nhé!",
      status: "open",
      options: [
        {
          id: "opt_1",
          courtName: "Sân cầu lông Tre Xanh (Tân Bình)",
          courtNumbers: "Sân 3 & 4 (2 sân)",
          date: "2026-10-01",
          startTime: "18:00",
          endTime: "20:00",
          price: 360000,
          note: "Khung giờ sớm, gần trung tâm Tân Bình"
        },
        {
          id: "opt_2",
          courtName: "Sân cầu lông Viettel (Hoàng Hoa Thám)",
          courtNumbers: "Sân 1 & 2 (2 sân)",
          date: "2026-10-01",
          startTime: "19:30",
          endTime: "21:30",
          price: 380000,
          note: "Khung giờ muộn, thảm mới 100% chuẩn thi đấu"
        }
      ],
      selectedOptionId: null,
      votes: [
        { memberId: "mem_1", selectedOptions: ["opt_1", "opt_2"], notGoing: false, guests: 0, votedAt: "2026-09-24 10:00" },
        { memberId: "mem_2", selectedOptions: ["opt_2"], notGoing: false, guests: 1, votedAt: "2026-09-24 11:30" },
        { memberId: "mem_3", selectedOptions: ["opt_1"], notGoing: false, guests: 0, votedAt: "2026-09-24 14:15" },
        { memberId: "mem_4", selectedOptions: ["opt_2"], notGoing: false, guests: 0, votedAt: "2026-09-24 15:20" },
        { memberId: "mem_6", selectedOptions: ["opt_1", "opt_2"], notGoing: false, guests: 0, votedAt: "2026-09-24 16:40" },
        { memberId: "mem_7", selectedOptions: ["opt_2"], notGoing: false, guests: 0, votedAt: "2026-09-24 17:00" },
        { memberId: "mem_5", selectedOptions: [], notGoing: true, note: "Trùng lịch học", votedAt: "2026-09-24 12:00" }
      ]
    },
    {
      id: "ses_past_1",
      title: "Giao lưu cầu lông Chủ nhật tuần trước",
      sessionType: "fixed",
      voteMode: "standard",
      date: "2026-09-20",
      startTime: "18:00",
      endTime: "20:00",
      courtName: "Sân cầu lông Tre Xanh",
      courtNumbers: "Sân 3 & Sân 4 (2 sân)",
      courtPrice: 360000,
      shuttleType: "Hải Yến Đỏ Pro (Tốc độ 77)",
      maxPlayers: 12,
      note: "Trận đấu giao lưu thành công tốt đẹp! Đã chốt số lượng 8 thành viên.",
      status: "completed",
      votes: [
        { memberId: "mem_1", status: "going", guests: 0, votedAt: "2026-09-18 10:00" },
        { memberId: "mem_2", status: "going", guests: 0, votedAt: "2026-09-18 11:30" },
        { memberId: "mem_3", status: "going", guests: 0, votedAt: "2026-09-18 14:15" },
        { memberId: "mem_4", status: "going", guests: 0, votedAt: "2026-09-18 15:20" },
        { memberId: "mem_6", status: "going", guests: 0, votedAt: "2026-09-18 16:40" },
        { memberId: "mem_7", status: "going", guests: 0, votedAt: "2026-09-18 17:00" }
      ]
    }
  ],

  monthlyContributions: [
    {
      id: "due_1",
      month: "2026-09",
      memberId: "mem_1",
      amount: 300000,
      status: "paid",
      paidAt: "2026-09-02 09:30",
      method: "Chuyển khoản VietQR",
      approvedBy: "Admin",
      approvedAt: "2026-09-02 09:35",
      note: "Đã nộp quỹ tháng 9"
    },
    {
      id: "due_2",
      month: "2026-09",
      memberId: "mem_2",
      amount: 300000,
      status: "paid",
      paidAt: "2026-09-03 14:20",
      method: "Chuyển khoản VietQR",
      approvedBy: "Tự động duyệt",
      approvedAt: "2026-09-03 14:20",
      note: "Thủ quỹ đóng quỹ"
    }
  ],

  transactions: [
    {
      id: "tx_1",
      date: "2026-09-01",
      type: "income",
      category: "Quỹ tháng",
      title: "Số dư quỹ tháng 8 chuyển sang",
      amount: 2450000,
      createdBy: "Trần Mai Anh (Thủ quỹ)",
      note: "Kết chuyển số dư đầu kỳ"
    },
    {
      id: "tx_2",
      date: "2026-09-05",
      type: "income",
      category: "Quỹ tháng",
      title: "Thu tiền quỹ cố định tháng 9",
      amount: 1200000,
      createdBy: "Trần Mai Anh (Thủ quỹ)",
      note: "Đợt 1 đầu tháng"
    },
    {
      id: "tx_3",
      date: "2026-09-12",
      type: "expense",
      category: "Tiền sân",
      title: "Chi tiền thuê sân cầu lông Tre Xanh (Sân 3 & 4)",
      amount: 720000,
      createdBy: "Trần Mai Anh (Thủ quỹ)",
      note: "Thanh toán ca giao lưu tuần 2"
    },
    {
      id: "tx_4",
      date: "2026-09-18",
      type: "expense",
      category: "Tiền cầu",
      title: "Mua 4 ống cầu Hải Yến Đỏ Pro (Tốc độ 77)",
      amount: 920000,
      createdBy: "Trần Mai Anh (Thủ quỹ)",
      note: "Bổ sung kho cầu tháng 9"
    }
  ],

  inventory: [
    {
      id: "inv_1",
      brand: "Hải Yến Đỏ Pro 77",
      tubesInStock: 8,
      pricePerTube: 230000,
      lastRestocked: "2026-09-10",
      shuttlesPerTube: 12
    }
  ]
};

// Mặc định nạp CSDL Vận hành thực tế (Production)
const DEFAULT_DATA = PROD_DEFAULT_DATA;
