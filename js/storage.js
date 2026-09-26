// Storage & Authentication Manager for SMASH PRO
// Quản lý lưu trữ LocalStorage, Xác thực tài khoản (Đăng nhập/Đăng ký) & Đồng bộ Google Drive Cloud

const STORAGE_KEY = "SMASH_PRO_BADMINTON_APP_V2";
const AUTH_SESSION_KEY = "SMASH_PRO_AUTH_SESSION_V2";
const ACTIVE_SHEET_KEY = "SMASH_PRO_ACTIVE_SHEET_V2";
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec";

const AppStorage = {
  googleScriptUrl: GOOGLE_SCRIPT_URL,
  cloudSyncStatus: 'idle', // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
  syncDebounceTimer: null,
  lastSyncedTime: null,
  activeSheet: 'CSDL_VanHanh_Prod', // 'CSDL_VanHanh_Prod' | 'CSDL_KiemThu_Test'

  isTestEnvironment() {
    try {
      if (window.__IS_TEST_ENV__ === true) return true;
      if (window.location && (window.location.search.includes('test=true') || window.location.search.includes('test=1') || window.location.search.includes('test='))) return true;
      if (window.location && window.location.port && window.location.port !== '8080' && window.location.port !== '80' && window.location.port !== '443' && window.location.port !== '') return true;
      if (window.location && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') && window.location.port && window.location.port !== '8080') return true;
    } catch(e) {}
    return false;
  },

  getActiveSheet() {
    if (this.isTestEnvironment()) {
      return 'CSDL_KiemThu_Test';
    }
    return localStorage.getItem(ACTIVE_SHEET_KEY) || 'CSDL_VanHanh_Prod';
  },

  // Khởi tạo hệ thống lưu trữ & đồng bộ
  init() {
    this.activeSheet = this.getActiveSheet();
    this.ensureDatabaseSchema();
    const envLabel = this.activeSheet === 'CSDL_VanHanh_Prod' ? 'Prod' : 'Test';
    this.updateSyncBadgeUI('syncing', `Google Drive (${envLabel}): Đang kết nối...`);
    this.pullFromCloud(false); // Đồng bộ ngầm từ Google Drive khi mở app
  },

  // Đảm bảo cấu trúc CSDL hợp lệ và đồng bộ phi phá hủy (Non-destructive Schema Initialization)
  ensureDatabaseSchema() {
    try {
      this.activeSheet = this.getActiveSheet();
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        // Khởi tạo mặc định CSDL Vận hành thực tế (Production)
        const initialProd = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
        initialProd.currentUser = null; // Mặc định chế độ Khách vãng lai
        initialProd.lastModified = Date.now();
        this.reconcileUsersAndMembers(initialProd);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initialProd));
        this.saveLocalBackup(initialProd);
      } else {
        let parsed = JSON.parse(stored);
        let updated = false;

        // Cập nhật nhãn phiên bản phi phá hủy (Tuyệt đối KHÔNG xóa/reset dữ liệu người dùng)
        if (parsed.version !== PROD_DEFAULT_DATA.version) {
          parsed.version = PROD_DEFAULT_DATA.version;
          updated = true;
        }

        // Đảm bảo danh sách users và tài khoản admin mặc định
        if (!Array.isArray(parsed.users) || parsed.users.length === 0) {
          parsed.users = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.users));
          updated = true;
        }
        if (!parsed.users.some(u => u.username === 'admin')) {
          parsed.users.unshift(JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.users[0])));
          updated = true;
        }
        // Đảm bảo mỗi user có thuộc tính themePreference
        parsed.users.forEach(u => {
          if (!u.themePreference) {
            u.themePreference = 'light';
            updated = true;
          }
        });

        // Bảo tồn toàn bộ danh sách thành viên thực tế của người dùng
        if (!Array.isArray(parsed.members)) {
          parsed.members = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.members || []));
          updated = true;
        }

        // Bảo tồn toàn bộ danh sách buổi đánh (sessions) của người dùng
        if (!Array.isArray(parsed.sessions)) {
          parsed.sessions = [];
          updated = true;
        }

        // Bảo tồn toàn bộ dữ liệu đóng quỹ (monthlyContributions) - Giữ nguyên trạng thái đã đóng
        if (!Array.isArray(parsed.monthlyContributions)) { 
          parsed.monthlyContributions = []; 
          updated = true; 
        }

        // Bảo tồn toàn bộ sổ thu chi (transactions) của người dùng
        if (!Array.isArray(parsed.transactions)) {
          parsed.transactions = [];
          updated = true;
        }

        // Đảm bảo thông tin kho hàng và CLB
        if (!parsed.inventory) { 
          parsed.inventory = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.inventory)); 
          updated = true; 
        }
        if (!parsed.clubInfo) { 
          parsed.clubInfo = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.clubInfo)); 
          updated = true; 
        } else if (!parsed.clubInfo.benefitsAndRules || !Array.isArray(parsed.clubInfo.benefitsAndRules) || parsed.clubInfo.benefitsAndRules.length === 0) {
          parsed.clubInfo.benefitsAndRules = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.clubInfo.benefitsAndRules));
          updated = true;
        }

        // Tự động làm sạch mọi tàn dư thử nghiệm và đối soát 2 chiều nhất quán
        parsed = this.sanitizeProductionData(parsed);
        this.reconcileUsersAndMembers(parsed);
        updated = true;

        if (updated) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
          this.saveLocalBackup(parsed);
        }
      }
    } catch (e) {
      console.error("Lỗi khởi tạo schema CSDL:", e);
      const restored = this.restoreFromBackup();
      if (!restored) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(PROD_DEFAULT_DATA));
      }
    }
  },

  // 1. Kiểm tra và làm sạch đối tượng hỏng kỹ thuật & rác kiểm thử (Bảo vệ 100% bản ghi người dùng hợp lệ)
  sanitizeProductionData(data) {
    if (!data) return data;
    if (typeof data !== 'object') return data;
    const isTest = this.isTestEnvironment();

    // Lọc users: Giữ lại toàn bộ tài khoản hợp lệ, khử trùng lặp và loại bỏ tài khoản kiểm thử rác
    if (Array.isArray(data.users)) {
      const isTestUser = (u) => {
        if (!u || (!u.id && !u.username)) return true;
        if (isTest) return false;
        const id = String(u.id || '');
        const un = String(u.username || '').toLowerCase();
        if (un === 'admin' || id === 'user_admin') return false; // Luôn giữ admin
        if (id.startsWith('user_test_') || id === 'user_vanhau' || id === 'user_regular') return true;
        if (un.startsWith('test_user_') || un === 'test_garbage') return true;
        return false;
      };

      const userMap = new Map();
      data.users.forEach(u => {
        if (!u || (!u.id && !u.username)) return;
        if (isTestUser(u)) return;
        const key = u.username || u.id;
        if (!userMap.has(key)) {
          userMap.set(key, { ...u });
        }
      });
      data.users = Array.from(userMap.values());
      if (!data.users.some(u => u.username === 'admin')) {
        data.users.unshift(JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.users[0])));
      }
    } else {
      data.users = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.users));
    }

    // Lọc members: Giữ lại toàn bộ thành viên hợp lệ, khử trùng lặp và loại bỏ thành viên kiểm thử rác
    if (Array.isArray(data.members)) {
      const isTestMember = (m) => {
        if (!m || (!m.id && !m.name && !m.phone)) return true;
        if (isTest) return false;
        const id = String(m.id || '');
        const un = String(m.username || '').toLowerCase();
        if (id === 'mem_admin' || un === 'admin') return false; // Luôn giữ admin
        if (id.startsWith('mem_test_') || id === 'mem_vanhau' || id === 'mem_regular') return true;
        return false;
      };

      const memberMap = new Map();
      data.members.forEach(m => {
        if (!m || (!m.id && !m.name && !m.phone)) return;
        if (isTestMember(m)) return;
        const key = m.id || m.username || (m.phone ? m.phone.replace(/\D/g, '') : null) || m.name;
        if (!memberMap.has(key)) {
          memberMap.set(key, { ...m });
        }
      });
      data.members = Array.from(memberMap.values());
      if (!data.members.some(m => m.id === 'mem_admin' || m.username === 'admin')) {
        data.members.unshift(JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.members[0])));
      }
    } else {
      data.members = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.members));
    }

    // Lọc sessions: Bảo toàn 100% ca đánh hợp lệ, loại bỏ ca đánh rác kiểm thử
    if (Array.isArray(data.sessions)) {
      data.sessions = data.sessions.filter(s => {
        if (!s || !s.id) return false;
        if (isTest) return true;
        const id = String(s.id);
        if (id.startsWith('session_test_') || id.startsWith('ses_test_')) return false;
        return true;
      });
    } else {
      data.sessions = [];
    }

    // Lọc monthlyContributions: Bảo toàn 100% bản ghi đóng quỹ hợp lệ (thuộc thành viên hiện có)
    const validMemberIds = new Set(data.members.map(m => m.id));
    if (Array.isArray(data.monthlyContributions)) {
      data.monthlyContributions = data.monthlyContributions.filter(d => d && d.memberId && validMemberIds.has(d.memberId));
    } else {
      data.monthlyContributions = [];
    }

    // Lọc transactions: Bảo toàn 100% giao dịch sổ quỹ hợp lệ do người dùng tạo
    if (Array.isArray(data.transactions)) {
      data.transactions = data.transactions.filter(t => {
        if (!t || !t.id) return false;
        if (isTest) return true;
        const strId = String(t.id);
        const title = (t.title || t.description || '').toLowerCase().trim();
        if (strId.startsWith('tx_test_') || strId === 'tx_1790423944296' || strId === 'tx_test_garbage') return false;
        if (title === 'cxasxa' || title === 's') return false;
        return true;
      });
    } else {
      data.transactions = [];
    }

    return data;
  },

  // 2. Cơ chế Đối soát & Đồng bộ 2 chiều tuyệt đối giữa Users (Tài khoản) và Members (Danh bạ)
  reconcileUsersAndMembers(data) {
    if (!data) return data;
    if (!Array.isArray(data.users)) data.users = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.users));
    if (!Array.isArray(data.members)) data.members = [];

    // Đảm bảo có tài khoản admin duy nhất
    let adminUser = data.users.find(u => u.username === 'admin');
    if (!adminUser) {
      adminUser = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.users[0]));
      data.users.unshift(adminUser);
    }

    // Đồng bộ từng user với member
    data.users.forEach(user => {
      if (!user) return;
      // Tìm member tương ứng
      let member = data.members.find(m => 
        (user.memberId && m.id === user.memberId) || 
        (user.username && m.username === user.username) ||
        (user.phone && m.phone && user.phone.replace(/\D/g, '') === m.phone.replace(/\D/g, ''))
      );

      if (member) {
        // Đồng bộ dữ liệu nhất quán 100%
        user.memberId = member.id;
        member.username = user.username;
        member.name = user.name;
        member.phone = user.phone || member.phone || '';
        if (user.email) member.email = user.email;
        if (user.avatar) member.avatar = user.avatar;
        if (user.note !== undefined) member.note = user.note;
        member.role = user.role;
        member.type = user.type || member.type || 'fixed';
      }
    });

    // 3. Làm sạch triệt để các bản ghi đóng quỹ mồ côi và đảm bảo 1:1 với thành viên cố định
    if (!Array.isArray(data.monthlyContributions)) data.monthlyContributions = [];
    if (Array.isArray(data.members)) {
      const activeFixedMembers = data.members.filter(m => m.type === 'fixed');
      const activeFixedMemberIds = new Set(activeFixedMembers.map(m => m.id));
      // Loại bỏ mồ côi
      data.monthlyContributions = data.monthlyContributions.filter(d => d && d.memberId && activeFixedMemberIds.has(d.memberId));
      
      const currentMonth = "2026-09";
      activeFixedMembers.forEach(m => {
        const hasDue = data.monthlyContributions.some(d => d.month === currentMonth && d.memberId === m.id);
        if (!hasDue) {
          data.monthlyContributions.push({
            id: `due_${currentMonth}_${m.id}`,
            month: currentMonth,
            memberId: m.id,
            amount: data.clubInfo?.monthlyFee || 300000,
            status: "unpaid",
            paidAt: null,
            method: null,
            billImage: null,
            approvedBy: null,
            approvedAt: null,
            note: "Chưa đóng"
          });
        }
      });
    }

    // 4. Làm sạch triệt để các phiếu bình chọn mồ côi, khử trùng lặp 1 người 1 vote & Chuẩn hóa memberId
    if (Array.isArray(data.sessions) && Array.isArray(data.members)) {
      const activeMemberIds = new Set(data.members.map(m => m.id));
      const activeUserIds = new Set((data.users || []).map(u => u.id));
      const userToMemberMap = new Map();
      (data.users || []).forEach(u => {
        if (u.id && u.memberId) userToMemberMap.set(u.id, u.memberId);
        if (u.username && u.memberId) userToMemberMap.set(u.username, u.memberId);
      });

      data.sessions.forEach(s => {
        if (!Array.isArray(s.voteHistory)) s.voteHistory = [];

        if (Array.isArray(s.votes)) {
          // Chuẩn hóa mọi phiếu vote cũ có v.memberId là userId/username thành memberId chuẩn
          s.votes.forEach(v => {
            if (v && v.memberId && userToMemberMap.has(v.memberId)) {
              v.memberId = userToMemberMap.get(v.memberId);
            }
          });

          // Khử trùng lặp triệt để: Mỗi thành viên chỉ có DUY NHẤT 1 phiếu bình chọn hiện tại (1 member = 1 active vote)
          const voteMap = new Map();
          s.votes.forEach(v => {
            if (v && v.memberId && (activeMemberIds.has(v.memberId) || activeUserIds.has(v.memberId))) {
              if (voteMap.has(v.memberId)) {
                const prev = voteMap.get(v.memberId);
                // Giữ bản ghi mới hơn
                if ((v.votedAt || '') >= (prev.votedAt || '')) {
                  voteMap.set(v.memberId, v);
                }
              } else {
                voteMap.set(v.memberId, v);
              }
            }
          });
          s.votes = Array.from(voteMap.values());

          // Tự động khởi tạo và chuẩn hóa lịch sử thay đổi (Vote History) nếu mảng đang rỗng nhưng có votes
          if (s.voteHistory.length === 0 && s.votes.length > 0) {
            s.voteHistory = s.votes.map((v, idx) => {
              const mem = (data.members || []).find(m => m.id === v.memberId) || 
                          (data.users || []).find(u => u.id === v.memberId || u.memberId === v.memberId) || 
                          { name: 'Thành viên', avatar: '' };
              let actionText = '';
              if (v.status === 'going') actionText = `Đăng ký tham gia${(v.guests || 0) > 0 ? ` (+${v.guests} khách)` : ''}`;
              else if (v.status === 'not_going' || v.notGoing) actionText = 'Báo vắng / Không đi';
              else if (v.status === 'maybe') actionText = 'Dự bị';
              else if (v.selectedOptions && v.selectedOptions.length > 0) actionText = `Bình chọn ${v.selectedOptions.length} phương án`;
              else actionText = 'Đã bình chọn';

              return {
                id: `vh_init_${v.memberId || idx}_${Date.now()}_${idx}`,
                memberId: v.memberId,
                memberName: mem.name || 'Thành viên',
                avatar: mem.avatar || '',
                status: v.status || (v.notGoing ? 'not_going' : (v.selectedOptions ? 'poll' : 'going')),
                actionText: actionText,
                guests: v.guests || 0,
                note: v.note || '',
                votedAt: v.votedAt || '2026-09-26 20:38'
              };
            });
          }
        } else {
          s.votes = [];
        }
      });
    }

    // 5. Làm sạch triệt để các giao dịch rác thử nghiệm trong CSDL
    if (Array.isArray(data.transactions)) {
      const isTest = this.isTestEnvironment();
      const isGarbageTx = (t) => {
        if (!t || !t.id) return true;
        if (isTest) return false;
        const strId = String(t.id);
        const title = (t.title || t.description || '').toLowerCase().trim();
        if (strId.startsWith('tx_test_') || strId === 'tx_1790423944296' || strId === 'tx_test_garbage') return true;
        if (title === 'cxasxa' || title === 's') return true;
        return false;
      };
      data.transactions = data.transactions.filter(t => !isGarbageTx(t));
    }

    // 6. Nếu user đang đăng nhập (currentUser), đồng bộ chính xác với bản ghi user trong users
    if (data.currentUser) {
      const liveUser = data.users.find(u => u.id === data.currentUser.id || u.username === data.currentUser.username);
      if (liveUser) {
        data.currentUser = liveUser;
      }
    }

    return data;
  },

  // Tải toàn bộ CSDL
  loadData() {
    this.ensureDatabaseSchema();
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        let parsed = this.sanitizeProductionData(JSON.parse(stored));
        this.reconcileUsersAndMembers(parsed);
        parsed.currentUser = this.getCurrentUser();
        return parsed;
      }
    } catch (e) {
      console.error("Lỗi đọc CSDL từ localStorage:", e);
    }
    const fallback = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
    fallback.currentUser = this.getCurrentUser();
    return fallback;
  },

  // Lưu toàn bộ CSDL và phát sự kiện đồng bộ (Tự động tạo bản sao lưu an toàn)
  saveData(data, syncToCloud = true) {
    try {
      data = this.sanitizeProductionData(data);
      data.lastModified = Date.now();
      this.saveLocalBackup(data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      window.dispatchEvent(new CustomEvent("app-state-changed", { detail: data }));

      if (syncToCloud && this.googleScriptUrl && !this.isTestEnvironment()) {
        this.pushToCloud(data, false); // Đồng bộ trực tiếp tức thời lên Cloud
      }
    } catch (e) {
      console.error("Lỗi lưu CSDL vào localStorage:", e);
    }
  },

  // ==========================================
  // HỆ THỐNG XÁC THỰC & QUẢN LÝ NGƯỜI DÙNG (AUTH)
  // ==========================================

  // Thời gian hết hạn do không hoạt động (15 phút)
  INACTIVITY_TIMEOUT: 15 * 60 * 1000,
  // Thời gian sống của phiên khi tick "Ghi nhớ" (24 giờ)
  SESSION_REMEMBER_TTL: 24 * 60 * 60 * 1000,
  // Thời gian sống của phiên tạm thời khi không tick "Ghi nhớ" (2 giờ)
  SESSION_TEMP_TTL: 2 * 60 * 60 * 1000,

  // Lấy thông tin tài khoản đang đăng nhập hiện tại (An toàn, kiểm tra TTL & Inactivity)
  getCurrentUser() {
    try {
      const rawSession = sessionStorage.getItem(AUTH_SESSION_KEY) || localStorage.getItem(AUTH_SESSION_KEY);
      if (!rawSession) {
        return null; // Chế độ Khách vãng lai (Guest)
      }

      const session = JSON.parse(rawSession);
      const now = Date.now();

      // 1. Kiểm tra thời hạn sống tuyệt đối của phiên (Session TTL)
      if (session.expiresAt && now > session.expiresAt) {
        console.warn("[Auth] Phiên đăng nhập đã hết hạn TTL. Tự động đăng xuất.");
        this.logout(false);
        return null;
      }

      // 2. Kiểm tra thời gian không hoạt động (Inactivity Timeout 15 phút)
      if (session.lastActivity && (now - session.lastActivity > this.INACTIVITY_TIMEOUT)) {
        console.warn("[Auth] Quá 15 phút không có thao tác. Tự động đăng xuất.");
        this.logout(false);
        return null;
      }

      // 3. Truy vấn thông tin người dùng trong CSDL
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        const user = (data.users || []).find(u => u.id === session.id || u.username === session.username);
        if (user) return user;
      }
    } catch (e) {
      console.error("Lỗi xác thực phiên đăng nhập:", e);
    }
    return null;
  },

  // Cập nhật timestamp hoạt động người dùng (Gia hạn thời gian Inactivity)
  touchActivity() {
    try {
      const rawSession = sessionStorage.getItem(AUTH_SESSION_KEY) || localStorage.getItem(AUTH_SESSION_KEY);
      if (!rawSession) return;
      const session = JSON.parse(rawSession);
      session.lastActivity = Date.now();
      
      if (sessionStorage.getItem(AUTH_SESSION_KEY)) {
        sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
      } else if (localStorage.getItem(AUTH_SESSION_KEY)) {
        localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
      }
    } catch (e) {
      // Ignored
    }
  },

  // Kiểm tra trạng thái đã đăng nhập hay chưa
  isLoggedIn() {
    return this.getCurrentUser() !== null;
  },

  // Kiểm tra quyền Admin/Thủ quỹ
  isAdmin() {
    const u = this.getCurrentUser();
    return !!(u && (u.role === 'admin' || u.role === 'treasurer'));
  },

  // Kiểm tra quyền Super Admin
  isSuperAdmin() {
    const u = this.getCurrentUser();
    return !!(u && u.role === 'admin');
  },

  // Kiểm tra quyền Thành viên thường
  isMember() {
    const u = this.getCurrentUser();
    return !!(u && u.role === 'member');
  },

  // Kiểm tra quyền Khách vãng lai (Chưa đăng nhập HOẶC tài khoản phân loại vãng lai 'guest')
  isGuest() {
    const u = this.getCurrentUser();
    if (!u) return true;
    return u.type === 'guest' && u.role !== 'admin' && u.role !== 'treasurer';
  },

  // Kiểm tra quyền Thành viên chính thức / Cố định (Đã đăng nhập và là Cố định hoặc Ban quản trị)
  isFixedMember() {
    const u = this.getCurrentUser();
    if (!u) return false;
    return u.role === 'admin' || u.role === 'treasurer' || u.type === 'fixed';
  },

  // Quyền xem sổ quỹ & báo cáo tài chính CLB (Chỉ dành cho Thành viên cố định & Ban quản trị)
  canViewFinance() {
    return this.isFixedMember();
  },

  // Quyền quản lý thành viên khác (Thêm, Sửa, Xóa, Duyệt, Đặt lại mật khẩu - Chỉ Ban quản trị)
  canManageMembers() {
    return this.isAdmin();
  },

  // Kiểm tra quyền xem thông tin liên hệ nhạy cảm (SĐT, Email) của một thành viên
  // Chỉ Quản trị viên HOẶC chính thành viên đó (Owner) mới được xem
  canViewMemberContact(targetMemberId = null, targetPhone = '') {
    if (this.isAdmin()) return true;
    const u = this.getCurrentUser();
    if (!u) return false;
    if (targetMemberId && (u.id === targetMemberId || u.memberId === targetMemberId)) return true;
    if (u.phone && targetPhone && u.phone.replace(/\D/g, '') === targetPhone.replace(/\D/g, '')) return true;
    return false;
  },

  // Che giấu số điện thoại để bảo vệ quyền riêng tư đối với thành viên khác
  maskPhone(phone, targetMemberId = null) {
    if (!phone) return '';
    if (this.canViewMemberContact(targetMemberId, phone)) {
      return phone;
    }
    const clean = phone.replace(/\D/g, '');
    if (clean.length < 7) return '••••••';
    const prefix = clean.slice(0, 4);
    const suffix = clean.slice(-3);
    return `${prefix}****${suffix}`;
  },

  // Che giấu email để bảo vệ quyền riêng tư đối với thành viên khác
  maskEmail(email, targetMemberId = null) {
    if (!email) return '';
    if (this.canViewMemberContact(targetMemberId)) {
      return email;
    }
    const parts = email.split('@');
    if (parts.length !== 2) return '••••••@••••';
    const name = parts[0];
    const domain = parts[1];
    if (name.length <= 2) return `${name[0]}*@${domain}`;
    return `${name.slice(0, 2)}***@${domain}`;
  },

  // Đăng nhập hệ thống
  login(usernameOrPhone, password, remember = false) {
    this.ensureDatabaseSchema();
    const data = this.loadData();
    const input = (usernameOrPhone || "").trim().toLowerCase();
    const pwd = (password || "").trim();

    if (!input || !pwd) {
      return { success: false, message: "Vui lòng nhập đầy đủ tên đăng nhập/SĐT và mật khẩu!" };
    }

    const user = (data.users || []).find(u => 
      (u.username.toLowerCase() === input || (u.phone && u.phone.replace(/\D/g, '') === input.replace(/\D/g, ''))) &&
      u.password === pwd
    );

    if (!user) {
      return { 
        success: false, 
        message: "Tên đăng nhập hoặc mật khẩu không chính xác, vui lòng kiểm tra lại!" 
      };
    }

    // Lưu phiên đăng nhập có TTL và Inactivity Timer
    const now = Date.now();
    const sessionData = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      memberId: user.memberId,
      loginAt: new Date().toISOString(),
      lastActivity: now,
      remember: !!remember,
      expiresAt: now + (remember ? this.SESSION_REMEMBER_TTL : this.SESSION_TEMP_TTL)
    };

    localStorage.removeItem('SMASH_PRO_LOGGED_OUT');
    if (remember) {
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
      sessionStorage.removeItem(AUTH_SESSION_KEY);
    } else {
      sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
      localStorage.removeItem(AUTH_SESSION_KEY);
    }

    // Cập nhật CSDL đồng bộ currentUser
    data.currentUser = user;
    this.saveData(data, false);

    return { success: true, user: user, message: `Chào mừng ${user.name} đã đăng nhập thành công!` };
  },

  // Đăng ký tài khoản người dùng mới
  register({ name, phone, usernameInput, password, confirmPassword, memberType = "fixed", remember = true }) {
    this.ensureDatabaseSchema();
    const data = this.loadData();

    // 1. Kiểm tra họ và tên
    const trimmedName = (name || "").trim();
    if (!trimmedName || trimmedName.length < 2) {
      return { success: false, message: "Vui lòng nhập họ và tên hợp lệ (tối thiểu 2 ký tự)!" };
    }

    // 2. Xác định Username từ SĐT hoặc Tên
    let finalUsername = "";
    const cleanPhone = (phone || "").replace(/\D/g, '');

    if (cleanPhone && cleanPhone.length >= 9) {
      finalUsername = cleanPhone;
    } else if (usernameInput && usernameInput.trim()) {
      finalUsername = usernameInput.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    } else {
      // Tự sinh username từ tên không dấu
      finalUsername = trimmedName.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(100 + Math.random() * 900);
    }

    if (!finalUsername || finalUsername.length < 3) {
      return { success: false, message: "Tên đăng nhập hoặc số điện thoại không hợp lệ!" };
    }

    // 3. Kiểm tra trùng lặp
    const exists = (data.users || []).some(u => 
      u.username.toLowerCase() === finalUsername.toLowerCase() || 
      (cleanPhone && u.phone && u.phone.replace(/\D/g, '') === cleanPhone)
    );

    if (exists) {
      return { 
        success: false, 
        message: `Tài khoản với tên đăng nhập hoặc SĐT "${finalUsername}" đã tồn tại trên hệ thống!` 
      };
    }

    // 4. Kiểm tra quy tắc mật khẩu (Password Policy)
    const pwd = (password || "").trim();
    if (pwd.length < 6) {
      return { success: false, message: "Mật khẩu bắt buộc phải có độ dài tối thiểu từ 6 ký tự trở lên!" };
    }
    if (/\s/.test(pwd)) {
      return { success: false, message: "Mật khẩu không được chứa khoảng trắng!" };
    }
    if (confirmPassword !== undefined && pwd !== confirmPassword.trim()) {
      return { success: false, message: "Mật khẩu xác nhận không khớp, vui lòng kiểm tra lại!" };
    }

    // 5. Tạo mới User & Member record
    const newUserId = "user_" + Date.now();
    const newMemberId = "mem_" + Date.now();
    const avatarList = [
      "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&auto=format&fit=crop&q=80"
    ];
    const randomAvatar = avatarList[Math.floor(Math.random() * avatarList.length)];

    const newUser = {
      id: newUserId,
      username: finalUsername,
      password: pwd,
      name: trimmedName,
      phone: cleanPhone || "",
      role: "member", // Người dùng đăng ký luôn có quyền member
      memberId: newMemberId,
      type: memberType,
      avatar: randomAvatar,
      themePreference: (window.App && window.App.theme) || localStorage.getItem('smash_pro_theme') || 'light',
      createdAt: new Date().toISOString()
    };

    const newMember = {
      id: newMemberId,
      username: finalUsername,
      name: trimmedName,
      role: "member",
      phone: cleanPhone || "",
      type: memberType,
      avatar: randomAvatar,
      joinDate: new Date().toISOString().slice(0, 10)
    };

    if (!data.users) data.users = [];
    if (!data.members) data.members = [];

    data.users.push(newUser);
    data.members.push(newMember);
    data.currentUser = newUser;

    // Lưu CSDL và đồng bộ Cloud
    this.saveData(data, true);

    // Lưu phiên đăng nhập có TTL và Inactivity Timer
    const now = Date.now();
    const sessionData = {
      id: newUser.id,
      username: newUser.username,
      name: newUser.name,
      role: newUser.role,
      memberId: newUser.memberId,
      loginAt: new Date().toISOString(),
      lastActivity: now,
      remember: !!remember,
      expiresAt: now + (remember ? this.SESSION_REMEMBER_TTL : this.SESSION_TEMP_TTL)
    };
    localStorage.removeItem('SMASH_PRO_LOGGED_OUT');
    if (remember) {
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
      sessionStorage.removeItem(AUTH_SESSION_KEY);
    } else {
      sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
      localStorage.removeItem(AUTH_SESSION_KEY);
    }

    return { 
      success: true, 
      user: newUser, 
      message: `Đăng ký thành công! Tên đăng nhập của bạn là: ${finalUsername}` 
    };
  },

  // Đăng xuất khỏi hệ thống
  logout(explicit = true) {
    if (explicit) {
      localStorage.setItem('SMASH_PRO_LOGGED_OUT', 'true');
    }
    localStorage.removeItem(AUTH_SESSION_KEY);
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    
    // Reset currentUser trong CSDL
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        data.currentUser = null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        window.dispatchEvent(new CustomEvent("app-state-changed", { detail: data }));
      }
    } catch (e) {
      console.error("Lỗi xóa phiên trong CSDL:", e);
    }
  },

  // ==========================================
  // BẢO MẬT & QUẢN LÝ MẬT KHẨU TÀI KHOẢN
  // ==========================================

  // Đổi mật khẩu tài khoản người dùng / Quản trị viên
  changePassword(userId, oldPassword, newPassword, confirmPassword) {
    this.ensureDatabaseSchema();
    const data = this.loadData();
    const user = (data.users || []).find(u => u.id === userId || u.username === userId);

    if (!user) {
      return { success: false, message: "Không tìm thấy tài khoản người dùng!" };
    }

    const oldPwd = (oldPassword || "").trim();
    const newPwd = (newPassword || "").trim();
    const confirmPwd = (confirmPassword || "").trim();

    if (user.password !== oldPwd) {
      return { success: false, message: "Mật khẩu hiện tại không chính xác!" };
    }

    if (newPwd.length < 6) {
      return { success: false, message: "Mật khẩu mới phải có tối thiểu từ 6 ký tự trở lên!" };
    }

    if (/\s/.test(newPwd)) {
      return { success: false, message: "Mật khẩu mới không được chứa khoảng trắng!" };
    }

    if (confirmPassword !== undefined && newPwd !== confirmPwd) {
      return { success: false, message: "Mật khẩu xác nhận không khớp!" };
    }

    if (newPwd === oldPwd) {
      return { success: false, message: "Mật khẩu mới không được trùng với mật khẩu cũ!" };
    }

    user.password = newPwd;
    user.updatedAt = new Date().toISOString();

    // Cập nhật session nếu là currentUser
    const currentUser = this.getCurrentUser();
    if (currentUser && (currentUser.id === user.id || currentUser.username === user.username)) {
      data.currentUser = user;
    }

    this.saveData(data, true);
    return { success: true, message: "Đổi mật khẩu thành công! Hãy ghi nhớ mật khẩu mới để đăng nhập." };
  },

  // Admin đặt lại mật khẩu cho thành viên
  adminResetUserPassword(memberIdOrUserId, newPassword) {
    if (!this.isAdmin()) {
      return { success: false, message: "Chỉ Quản trị viên mới có quyền đặt lại mật khẩu cho thành viên!" };
    }

    const newPwd = (newPassword || "").trim();
    if (newPwd.length < 6) {
      return { success: false, message: "Mật khẩu mới phải có tối thiểu 6 ký tự trở lên!" };
    }
    if (/\s/.test(newPwd)) {
      return { success: false, message: "Mật khẩu không được chứa khoảng trắng!" };
    }

    const data = this.loadData();
    const user = (data.users || []).find(u => u.memberId === memberIdOrUserId || u.id === memberIdOrUserId || u.username === memberIdOrUserId);

    if (!user) {
      return { success: false, message: "Không tìm thấy tài khoản tương ứng với thành viên này!" };
    }

    user.password = newPwd;
    user.updatedAt = new Date().toISOString();
    this.saveData(data, true);

    return { success: true, message: `Đã cập nhật mật khẩu mới cho tài khoản "${user.name}" thành công!` };
  },

  // Cập nhật thông tin hồ sơ cá nhân và Avatar của người dùng hiện tại
  updateUserProfile({ userId, name, phone, email, avatar, note, bio, currentPassword, newPassword, confirmPassword }) {
    this.ensureDatabaseSchema();
    const data = this.loadData();
    const user = (data.users || []).find(u => u.id === userId || u.username === userId);

    if (!user) {
      return { success: false, message: "Không tìm thấy thông tin tài khoản người dùng!" };
    }

    const trimmedName = (name || "").trim();
    if (!trimmedName || trimmedName.length < 2) {
      return { success: false, message: "Họ và tên bắt buộc phải có tối thiểu 2 ký tự!" };
    }

    const cleanPhone = (phone || "").replace(/\D/g, '');
    if (phone && cleanPhone && (cleanPhone.length < 9 || cleanPhone.length > 11)) {
      return { success: false, message: "Số điện thoại không hợp lệ (cần từ 9 - 11 chữ số)!" };
    }

    // Kiểm tra trùng SĐT với người khác
    if (cleanPhone) {
      const duplicateUser = (data.users || []).find(u => u.id !== user.id && u.phone && u.phone.replace(/\D/g, '') === cleanPhone);
      if (duplicateUser) {
        return { success: false, message: `Số điện thoại ${phone} đã được sử dụng bởi tài khoản "${duplicateUser.name}"!` };
      }
    }

    // Xử lý đổi mật khẩu nếu có
    if (newPassword && newPassword.trim()) {
      const currentPwd = (currentPassword || "").trim();
      const newPwd = newPassword.trim();
      const confirmPwd = (confirmPassword || "").trim();

      if (!currentPwd) {
        return { success: false, message: "Vui lòng nhập mật khẩu hiện tại để xác nhận thay đổi mật khẩu!" };
      }
      if (user.password !== currentPwd) {
        return { success: false, message: "Mật khẩu hiện tại không chính xác!" };
      }
      if (newPwd.length < 6) {
        return { success: false, message: "Mật khẩu mới phải có tối thiểu từ 6 ký tự trở lên!" };
      }
      if (/\s/.test(newPwd)) {
        return { success: false, message: "Mật khẩu mới không được chứa khoảng trắng!" };
      }
      if (confirmPassword !== undefined && newPwd !== confirmPwd) {
        return { success: false, message: "Mật khẩu xác nhận không khớp!" };
      }
      user.password = newPwd;
    }

    // Cập nhật User
    user.name = trimmedName;
    if (phone !== undefined) user.phone = phone.trim();
    if (email !== undefined) user.email = email.trim();
    if (avatar) user.avatar = avatar;
    if (note !== undefined || bio !== undefined) user.note = (note || bio || '').trim();
    user.updatedAt = new Date().toISOString();

    // Cập nhật Member tương ứng trong data.members
    let member = (data.members || []).find(m => m.id === user.memberId || (m.username && m.username === user.username) || (m.phone && cleanPhone && m.phone.replace(/\D/g, '') === cleanPhone));
    if (member) {
      member.name = user.name;
      member.phone = user.phone;
      if (email !== undefined) member.email = user.email;
      if (avatar) member.avatar = user.avatar;
      if (user.note !== undefined) member.note = user.note;
    } else if (user.memberId) {
      member = {
        id: user.memberId,
        username: user.username,
        name: user.name,
        phone: user.phone || '',
        email: user.email || '',
        note: user.note || '',
        type: user.type || 'fixed',
        role: user.role || 'member',
        avatar: user.avatar,
        joinDate: new Date().toISOString().slice(0, 10)
      };
      if (!data.members) data.members = [];
      data.members.push(member);
    }

    // Đồng bộ session
    const currentSession = this.getCurrentUser();
    if (currentSession && (currentSession.id === user.id || currentSession.username === user.username)) {
      data.currentUser = user;
      try {
        const rawSession = sessionStorage.getItem(AUTH_SESSION_KEY) || localStorage.getItem(AUTH_SESSION_KEY);
        if (rawSession) {
          sess.name = user.name;
          sess.avatar = user.avatar;
          sess.phone = user.phone;
          sess.email = user.email;
          sess.note = user.note;
          if (sessionStorage.getItem(AUTH_SESSION_KEY)) sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sess));
          if (localStorage.getItem(AUTH_SESSION_KEY)) localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sess));
        }
      } catch (e) {}
    }

    this.saveData(data, true);
    return { success: true, user: user, message: "Cập nhật hồ sơ cá nhân và ảnh đại diện thành công!" };
  },

  // ==========================================
  // CHẾ ĐỘ DỮ LIỆU: PRODUCTION VS TEST DEMO
  // ==========================================
  
  switchDatabaseMode(mode) {
    if (mode === 'test') {
      const testData = JSON.parse(JSON.stringify(TEST_MOCK_DATA));
      testData.currentUser = this.getCurrentUser();
      this.activeSheet = 'CSDL_KiemThu_Test';
      localStorage.setItem(ACTIVE_SHEET_KEY, 'CSDL_KiemThu_Test');
      this.saveData(testData, true);
      return testData;
    } else {
      const prodData = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
      prodData.currentUser = this.getCurrentUser();
      this.activeSheet = 'CSDL_VanHanh_Prod';
      localStorage.setItem(ACTIVE_SHEET_KEY, 'CSDL_VanHanh_Prod');
      this.saveData(prodData, true);
      return prodData;
    }
  },

  // ==========================================
  // ĐỒNG BỘ ĐÁM MÂY GOOGLE DRIVE / SHEETS
  // ==========================================

  async pushToCloud(data = null, showToast = true) {
    if (this.isTestEnvironment()) {
      console.log(`[TestEnv] Môi trường kiểm thử (cổng ${window.location.port || 'default'}). Chặn đồng bộ lên Google Drive thực tế để bảo vệ dữ liệu sản xuất.`);
      this.cloudSyncStatus = 'synced';
      this.updateSyncBadgeUI('synced', `Test Mode (Mock Cloud Sync)`);
      return true;
    }

    this.activeSheet = this.getActiveSheet();
    const payload = this.sanitizeProductionData(data || this.loadData());
    payload.sheetName = this.activeSheet;
    const envLabel = this.activeSheet === 'CSDL_VanHanh_Prod' ? 'Prod' : 'Test';
    this.updateSyncBadgeUI('syncing', `Google Drive (${envLabel}): Đang lưu...`);

    try {
      const url = `${this.googleScriptUrl}?sheet=${encodeURIComponent(this.activeSheet)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify(payload)
      });

      this.lastSyncedTime = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      this.cloudSyncStatus = 'synced';
      this.updateSyncBadgeUI('synced', `Google Drive (${envLabel}): Đã đồng bộ (${this.lastSyncedTime})`);

      if (showToast && window.App) {
        App.showToast(`☁️ Đã lưu CSDL lên Google Drive (${this.activeSheet}) thành công!`, "success");
      }
      return true;
    } catch (err) {
      console.warn("Cloud push failed, saved locally:", err);
      this.cloudSyncStatus = 'offline';
      this.updateSyncBadgeUI('offline', `Google Drive (${envLabel}): Offline`);
      if (showToast && window.App) {
        App.showToast("⚠️ Không thể kết nối Google Drive, dữ liệu đã lưu an toàn trên máy bạn!", "warning");
      }
      return false;
    }
  },

  // ==========================================
  // HỆ THỐNG KIỂM SOÁT & BẢO VỆ DỮ LIỆU AN TOÀN (DATA PROTECTION & ROLLING BACKUPS)
  // ==========================================
  BACKUP_PRIMARY_KEY: 'SMASH_PRO_AUTO_BACKUP_PRIMARY',
  BACKUP_HISTORY_KEY: 'SMASH_PRO_AUTO_BACKUP_HISTORY',

  // Tự động lưu bản sao lưu an toàn (Rolling Backup) trước mọi thao tác ghi dữ liệu
  saveLocalBackup(data) {
    try {
      if (!data || typeof data !== 'object') return;
      const snapshot = JSON.stringify({
        timestamp: Date.now(),
        savedAt: new Date().toLocaleString('vi-VN'),
        membersCount: (data.members || []).length,
        sessionsCount: (data.sessions || []).length,
        txCount: (data.transactions || []).length,
        data: data
      });

      // 1. Bản snapshot chính
      localStorage.setItem(this.BACKUP_PRIMARY_KEY, snapshot);

      // 2. Lịch sử 5 bản sao lưu gần nhất
      const historyRaw = localStorage.getItem(this.BACKUP_HISTORY_KEY);
      let history = [];
      if (historyRaw) {
        try { history = JSON.parse(historyRaw); } catch(e){}
      }
      if (!Array.isArray(history)) history = [];

      const lastEntry = history[0];
      if (!lastEntry || (Date.now() - lastEntry.timestamp > 5000) || 
          lastEntry.membersCount !== (data.members || []).length ||
          lastEntry.sessionsCount !== (data.sessions || []).length ||
          lastEntry.txCount !== (data.transactions || []).length) {
        history.unshift({
          timestamp: Date.now(),
          savedAt: new Date().toLocaleString('vi-VN'),
          membersCount: (data.members || []).length,
          sessionsCount: (data.sessions || []).length,
          txCount: (data.transactions || []).length,
          data: data
        });
        history = history.slice(0, 5);
        localStorage.setItem(this.BACKUP_HISTORY_KEY, JSON.stringify(history));
      }
    } catch (e) {
      console.warn("Không thể lưu bản sao lưu cục bộ:", e);
    }
  },

  // Khôi phục tự động từ bản sao lưu gần nhất khi gặp sự cố
  restoreFromBackup() {
    try {
      const primary = localStorage.getItem(this.BACKUP_PRIMARY_KEY);
      if (primary) {
        const parsed = JSON.parse(primary);
        if (parsed && parsed.data) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed.data));
          console.log("[DataGuard] Đã tự động khôi phục dữ liệu từ bản sao lưu an toàn:", parsed.savedAt);
          return parsed.data;
        }
      }
    } catch (e) {
      console.error("Lỗi khôi phục sao lưu:", e);
    }
    return null;
  },

  // Hợp nhất dữ liệu thông minh hai chiều không mất mát (Lossless Smart Cloud Sync) giữa LocalStorage và Google Drive
  mergeCloudWithLocal(localData, cloudData) {
    if (!cloudData) return this.reconcileUsersAndMembers(this.sanitizeProductionData(localData || JSON.parse(JSON.stringify(PROD_DEFAULT_DATA))));
    if (!localData) return this.reconcileUsersAndMembers(this.sanitizeProductionData(cloudData));

    const cleanCloud = this.sanitizeProductionData(cloudData);
    const cleanLocal = this.sanitizeProductionData(localData);

    const localTime = Number(cleanLocal?.lastModified) || 0;
    const cloudTime = Number(cleanCloud?.lastModified) || 0;

    let merged = { ...PROD_DEFAULT_DATA };
    merged.version = PROD_DEFAULT_DATA.version;
    merged.mode = 'production';

    // 1. Dữ liệu máy trạm (Local) mới hơn hoặc bằng Cloud -> Ưu tiên tuyệt đối dữ liệu máy trạm
    if (localTime >= cloudTime && localTime > 0) {
      merged = {
        ...PROD_DEFAULT_DATA,
        ...cleanCloud,
        ...cleanLocal,
        members: cleanLocal.members || [],
        users: cleanLocal.users || [],
        sessions: cleanLocal.sessions || [],
        transactions: cleanLocal.transactions || [],
        monthlyContributions: cleanLocal.monthlyContributions || [],
        clubInfo: cleanLocal.clubInfo || cleanCloud.clubInfo || PROD_DEFAULT_DATA.clubInfo,
        inventory: cleanLocal.inventory || cleanCloud.inventory || PROD_DEFAULT_DATA.inventory,
        lastModified: localTime
      };
    } 
    // 2. Dữ liệu Cloud mới hơn máy trạm -> Ưu tiên dữ liệu Cloud
    else if (cloudTime > localTime && cloudTime > 0) {
      merged = {
        ...PROD_DEFAULT_DATA,
        ...cleanLocal,
        ...cleanCloud,
        members: cleanCloud.members || [],
        users: cleanCloud.users || [],
        sessions: cleanCloud.sessions || [],
        transactions: cleanCloud.transactions || [],
        monthlyContributions: cleanCloud.monthlyContributions || [],
        clubInfo: cleanCloud.clubInfo || cleanLocal.clubInfo || PROD_DEFAULT_DATA.clubInfo,
        inventory: cleanCloud.inventory || cleanLocal.inventory || PROD_DEFAULT_DATA.inventory,
        lastModified: cloudTime
      };
    } 
    // 3. Không xác định được timestamp -> Hợp nhất bảo toàn thông minh (Smart Union)
    else {
      merged.lastModified = Math.max(cloudTime, localTime, Date.now());
      merged.clubInfo = cleanLocal.clubInfo || cleanCloud.clubInfo || PROD_DEFAULT_DATA.clubInfo;
      merged.inventory = cleanLocal.inventory || cleanCloud.inventory || PROD_DEFAULT_DATA.inventory;

      // Hợp nhất danh sách thành viên (Members Union)
      const memberMap = new Map();
      [...(cleanCloud.members || []), ...(cleanLocal.members || [])].forEach(m => {
        if (!m || !m.id) return;
        if (!memberMap.has(m.id)) memberMap.set(m.id, { ...m });
        else memberMap.set(m.id, { ...memberMap.get(m.id), ...m });
      });
      merged.members = Array.from(memberMap.values());

      // Hợp nhất danh sách tài khoản (Users Union)
      const userMap = new Map();
      [...(cleanCloud.users || []), ...(cleanLocal.users || [])].forEach(u => {
        if (!u || (!u.id && !u.username)) return;
        const key = u.username || u.id;
        if (!userMap.has(key)) userMap.set(key, { ...u });
        else userMap.set(key, { ...userMap.get(key), ...u });
      });
      merged.users = Array.from(userMap.values());

      // Hợp nhất ca đánh (Sessions Union), bảo toàn phiếu bình chọn & lịch sử thay đổi (Vote History Merge)
      const sessionMap = new Map();
      [...(cleanCloud.sessions || []), ...(cleanLocal.sessions || [])].forEach(s => {
        if (!s || !s.id) return;
        if (!sessionMap.has(s.id)) {
          sessionMap.set(s.id, { 
            ...s, 
            votes: Array.isArray(s.votes) ? [...s.votes] : [],
            voteHistory: Array.isArray(s.voteHistory) ? [...s.voteHistory] : []
          });
        } else {
          const existing = sessionMap.get(s.id);
          // Gộp votes theo memberId (ưu tiên bản ghi mới nhất)
          const voteMap = new Map();
          (existing.votes || []).forEach(v => { if (v && v.memberId) voteMap.set(v.memberId, v); });
          (s.votes || []).forEach(v => { 
            if (v && v.memberId) {
              if (voteMap.has(v.memberId)) {
                const prev = voteMap.get(v.memberId);
                if ((v.votedAt || '') >= (prev.votedAt || '')) voteMap.set(v.memberId, v);
              } else {
                voteMap.set(v.memberId, v);
              }
            }
          });
          const mergedVotes = Array.from(voteMap.values());

          // Gộp lịch sử voteHistory
          const historyMap = new Map();
          [...(existing.voteHistory || []), ...(s.voteHistory || [])].forEach(h => {
            if (!h) return;
            const key = h.id || `${h.memberId}_${h.votedAt}_${h.actionText || h.status}`;
            if (!historyMap.has(key)) historyMap.set(key, h);
          });
          const mergedHistory = Array.from(historyMap.values());

          sessionMap.set(s.id, { ...existing, ...s, votes: mergedVotes, voteHistory: mergedHistory });
        }
      });
      merged.sessions = Array.from(sessionMap.values());

      // Hợp nhất sổ thu chi (Transactions Union)
      const txMap = new Map();
      [...(cleanCloud.transactions || []), ...(cleanLocal.transactions || [])].forEach(t => {
        if (!t || !t.id) return;
        if (!txMap.has(t.id)) txMap.set(t.id, { ...t });
        else txMap.set(t.id, { ...txMap.get(t.id), ...t });
      });
      merged.transactions = Array.from(txMap.values());

      // Hợp nhất đóng quỹ (Monthly Contributions Union)
      const dueMap = new Map();
      [...(cleanCloud.monthlyContributions || []), ...(cleanLocal.monthlyContributions || [])].forEach(d => {
        if (!d || !d.memberId) return;
        const key = d.id || `${d.month}_${d.memberId}`;
        if (!dueMap.has(key)) dueMap.set(key, { ...d });
        else if (d.status === 'paid') dueMap.set(key, { ...dueMap.get(key), ...d });
      });
      merged.monthlyContributions = Array.from(dueMap.values());
    }

    if (merged.members.length === 0) {
      merged.members = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.members));
    }

    // Luôn hợp nhất bảo toàn lịch sử bình chọn (Vote History Union) cho toàn bộ ca đánh
    if (Array.isArray(merged.sessions)) {
      const localSessionMap = new Map((cleanLocal?.sessions || []).map(s => [s.id, s]));
      const cloudSessionMap = new Map((cleanCloud?.sessions || []).map(s => [s.id, s]));

      merged.sessions.forEach(s => {
        if (!s || !s.id) return;
        const localS = localSessionMap.get(s.id);
        const cloudS = cloudSessionMap.get(s.id);
        const historyMap = new Map();
        [...(localS?.voteHistory || []), ...(cloudS?.voteHistory || []), ...(s.voteHistory || [])].forEach(h => {
          if (!h) return;
          const key = h.id || `${h.memberId}_${h.votedAt}_${h.actionText || h.status}`;
          if (!historyMap.has(key)) historyMap.set(key, h);
        });
        s.voteHistory = Array.from(historyMap.values());
      });
    }

    // Bảo tồn phiên đăng nhập (currentUser) và tùy chọn giao diện (theme)
    if (cleanLocal && cleanLocal.currentUser) {
      const liveUser = (merged.users || []).find(u => u.id === cleanLocal.currentUser.id || u.username === cleanLocal.currentUser.username);
      if (liveUser) {
        if (cleanLocal.currentUser.themePreference) {
          liveUser.themePreference = cleanLocal.currentUser.themePreference;
        }
        merged.currentUser = liveUser;
      } else {
        merged.currentUser = cleanLocal.currentUser;
      }
    } else {
      merged.currentUser = null;
    }

    // Dọn dẹp hợp lệ & đối soát đồng bộ
    this.reconcileUsersAndMembers(merged);

    // Lưu bản sao lưu an toàn tự động
    this.saveLocalBackup(merged);

    return merged;
  },

  // Xuất toàn bộ CSDL ra tệp JSON dự phòng
  exportDatabaseJSON() {
    const data = this.loadData();
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `smash_pro_backup_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    if (window.App) App.showToast("📁 Đã xuất tệp sao lưu CSDL (.json) thành công!", "success");
  },

  exportBackup() {
    this.exportDatabaseJSON();
  },

  // Phục hồi CSDL từ tệp JSON
  importDatabaseJSON(jsonContent) {
    try {
      const parsed = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      if (!parsed || !parsed.clubInfo) {
        throw new Error("Cấu trúc tệp sao lưu không hợp lệ!");
      }
      parsed.lastModified = Date.now();
      this.saveData(parsed, true);
      if (window.App) {
        App.showToast("🎉 Đã phục hồi dữ liệu từ tệp sao lưu thành công!", "success");
        App.refreshDashboardStats();
        App.renderUserHeaderAndSidebar();
      }
      return true;
    } catch (err) {
      console.error("Lỗi nhập dữ liệu:", err);
      if (window.App) App.showToast("❌ Không thể phục hồi CSDL: " + err.message, "error");
      return false;
    }
  },

  handleBackupFileUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.importDatabaseJSON(e.target.result);
    };
    reader.readAsText(file);
  },

  async resetData(showToast = true) {
    const prodData = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
    prodData.currentUser = this.getCurrentUser();
    prodData.lastModified = Date.now();
    
    // 1. Lưu cục bộ
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prodData));
    window.dispatchEvent(new CustomEvent("app-state-changed", { detail: prodData }));

    // 2. Cập nhật giao diện tức thì
    if (window.App) {
      App.refreshDashboardStats();
      App.renderUserHeaderAndSidebar();
      if (App.currentTab) App.renderTabContent(App.currentTab);
      if (showToast) App.showToast("Đang đồng bộ đặt lại CSDL sạch lên Google Drive...", "info");
    }

    // 3. Đẩy trực tiếp và đợi Google Drive xác nhận
    if (this.googleScriptUrl) {
      const pushed = await this.pushToCloud(prodData, false);
      if (pushed && window.App && showToast) {
        App.showToast("🎉 Đã làm sạch toàn bộ CSDL và đồng bộ lên Google Drive thành công!", "success");
      }
    }

    return prodData;
  },

  async pullFromCloud(showToast = true) {
    if (this.isTestEnvironment()) {
      console.log(`[TestEnv] Môi trường kiểm thử (cổng ${window.location.port || 'default'}). Bỏ qua tải từ Google Drive sản xuất.`);
      this.cloudSyncStatus = 'synced';
      this.updateSyncBadgeUI('synced', `Test Mode (Local Data)`);
      return this.loadData();
    }

    this.activeSheet = this.getActiveSheet();
    const envLabel = this.activeSheet === 'CSDL_VanHanh_Prod' ? 'Prod' : 'Test';
    this.updateSyncBadgeUI('syncing', `Google Drive (${envLabel}): Đang tải...`);
    
    try {
      const url = `${this.googleScriptUrl}?sheet=${encodeURIComponent(this.activeSheet)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" }
      });
      const text = await res.text();
      let cloudData = null;

      try {
        cloudData = JSON.parse(text);
      } catch (parseErr) {
        console.log("Dữ liệu cloud chưa phải JSON hoặc chưa khởi tạo:", text);
      }

      if (cloudData && cloudData.clubInfo && cloudData.users) {
        const localStored = localStorage.getItem(STORAGE_KEY);
        let localData = null;
        if (localStored) {
          try {
            localData = JSON.parse(localStored);
          } catch(e) {}
        }

        const localTime = Number(localData?.lastModified) || 0;
        const cloudTime = Number(cloudData?.lastModified) || 0;

        // Thực hiện Hợp nhất thông minh hai chiều (Two-Way Smart Merge)
        const finalMerged = this.mergeCloudWithLocal(localData, cloudData);

        // Lưu vào LocalStorage
        localStorage.setItem(STORAGE_KEY, JSON.stringify(finalMerged));
        this.lastSyncedTime = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        this.cloudSyncStatus = 'synced';
        this.updateSyncBadgeUI('synced', `Google Drive (${envLabel}): Đã đồng bộ (${this.lastSyncedTime})`);
        
        window.dispatchEvent(new CustomEvent("app-state-changed", { detail: finalMerged }));

        // Tự động đẩy lên Google Drive nếu máy trạm có dữ liệu mới hơn Cloud
        if (localTime > cloudTime && !this.isTestEnvironment()) {
          this.pushToCloud(finalMerged, false);
        }

        if (showToast && window.App) {
          App.showToast(`☁️ Đã đồng bộ CSDL với Google Drive (${this.activeSheet})!`, "success");
        }

        // Tự động áp dụng theme cá nhân hóa nếu người dùng đang đăng nhập
        if (window.App && finalMerged) {
          const currentLoggedIn = this.getCurrentUser();
          if (currentLoggedIn) {
            const freshUser = (finalMerged.users || []).find(u => u.id === currentLoggedIn.id);
            if (freshUser && freshUser.themePreference) {
              window.App.applyUserTheme(freshUser);
            }
          }
        }
        return finalMerged;
      } else {
        console.log("Khởi tạo dữ liệu sạch ban đầu lên Google Drive...");
        const initial = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
        initial.lastModified = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
        await this.pushToCloud(initial, false);
        return initial;
      }
    } catch (err) {
      console.warn("Không thể tải từ Google Drive, sử dụng CSDL cục bộ:", err);
      this.cloudSyncStatus = 'offline';
      this.updateSyncBadgeUI('offline', `Google Drive (${envLabel}): Offline`);
      if (showToast && window.App) {
        App.showToast("⚠️ Đang chạy ở chế độ Offline với dữ liệu trên thiết bị.", "warning");
      }
      return this.loadData();
    }
  },

  updateSyncBadgeUI(status, text) {
    const badgeEl = document.getElementById('cloud-sync-badge');
    const textEl = document.getElementById('cloud-sync-text');
    if (!badgeEl || !textEl) return;

    textEl.innerText = text;
    badgeEl.className = 'badge';

    if (status === 'synced') {
      badgeEl.classList.add('badge-paid');
      badgeEl.innerHTML = `<i class="fas fa-cloud-check text-primary"></i> <span id="cloud-sync-text">${text}</span>`;
    } else if (status === 'syncing') {
      badgeEl.classList.add('badge-info');
      badgeEl.innerHTML = `<i class="fas fa-sync fa-spin text-secondary"></i> <span id="cloud-sync-text">${text}</span>`;
    } else {
      badgeEl.classList.add('badge-warning');
      badgeEl.innerHTML = `<i class="fas fa-cloud text-warning"></i> <span id="cloud-sync-text">${text}</span>`;
    }
  }
};

window.AppStorage = AppStorage;
