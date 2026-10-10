// Khung dữ liệu rỗng cho môi trường Vận hành thực tế (Production)
// QUY TẮC: tệp này KHÔNG chứa bất kỳ dữ liệu mẫu/giả định nào (người dùng, thành viên, tài khoản ngân hàng,
// số tiền, lịch sử...). Mọi dữ liệu hiển thị phải do người dùng nhập hoặc tải từ máy chủ.
// Chỉ giữ cấu trúc trường và các tham số vận hành có giá trị trung tính.
const PROD_DEFAULT_DATA = {
  version: "2.9_PROD",
  sheetName: "CSDL_VanHanh_Prod",
  lastModified: 0,

  clubInfo: {
    name: "",
    shortName: "",
    season: "",
    description: "",
    logo: "assets/badminton-logo.svg",
    defaultCourt: "",
    address: "",
    bannerSubtitle: "",
    mapUrl: "",
    monthlyFundFee: 0,
    monthlyFee: 0,
    guestFee: 0,
    voteLockHours: 48,
    bank: {
      bankId: "",
      accountNo: "",
      accountName: "",
      qrTemplate: "compact2"
    },
    benefitsAndRules: []
  },

  // KHÔNG đặt tài khoản/mật khẩu ở đây: tài khoản thật chỉ nằm trên máy chủ.
  users: [],
  currentUser: null,
  members: [],
  sessions: [],
  monthlyContributions: [],
  transactions: [],
  inventory: []
};
