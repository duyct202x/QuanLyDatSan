// Storage & Authentication Manager for SMASH PRO
// Quản lý lưu trữ LocalStorage, Xác thực tài khoản (Đăng nhập/Đăng ký) & Đồng bộ Google Drive Cloud

const STORAGE_KEY = "SMASH_PRO_BADMINTON_APP_V2";
const AUTH_SESSION_KEY = "SMASH_PRO_AUTH_SESSION_V2";
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec";

const AppStorage = {
  googleScriptUrl: GOOGLE_SCRIPT_URL,
  cloudSyncStatus: 'idle', // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
  syncDebounceTimer: null,
  lastSyncedTime: null,
  activeSheet: 'CSDL_VanHanh_Prod', // 'CSDL_VanHanh_Prod' | 'CSDL_KiemThu_Test'

  // Khởi tạo hệ thống lưu trữ & đồng bộ
  init() {
    this.ensureDatabaseSchema();
    this.updateSyncBadgeUI('syncing', 'Đang kết nối Google Drive...');
    this.pullFromCloud(false); // Đồng bộ ngầm từ Google Drive khi mở app
  },

  // Đảm bảo cấu trúc CSDL hợp lệ và có sẵn tài khoản Admin mặc định
  ensureDatabaseSchema() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        // Khởi tạo mặc định CSDL Vận hành thực tế (Production)
        const initialProd = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initialProd));
        
        // Mặc định tạo session đăng nhập Admin cho người dùng lần đầu
        const adminUser = initialProd.users[0];
        const defaultSession = {
          id: adminUser.id,
          username: adminUser.username,
          name: adminUser.name,
          role: adminUser.role,
          memberId: adminUser.memberId,
          loginAt: new Date().toISOString()
        };
        localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(defaultSession));
      } else {
        const parsed = JSON.parse(stored);
        let updated = false;

        // Tự động nâng cấp schema nếu phiên bản cũ
        if (parsed.version !== PROD_DEFAULT_DATA.version) {
          parsed.version = PROD_DEFAULT_DATA.version;
          updated = true;
        }

        // Đảm bảo có danh sách users và tài khoản admin mặc định
        if (!parsed.users || parsed.users.length === 0) {
          parsed.users = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.users));
          updated = true;
        }
        const hasAdmin = parsed.users.some(u => u.username === 'admin');
        if (!hasAdmin) {
          parsed.users.unshift(PROD_DEFAULT_DATA.users[0]);
          updated = true;
        }

        if (!parsed.members || parsed.members.length === 0) {
          parsed.members = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.members));
          updated = true;
        }

        // Đảm bảo các buổi đánh mặc định luôn tồn tại đầy đủ
        if (!parsed.sessions || parsed.sessions.length === 0) {
          parsed.sessions = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.sessions));
          updated = true;
        } else {
          // Bổ sung các buổi ses_1, ses_poll_1, ses_past_1 nếu chưa có trong sessions
          PROD_DEFAULT_DATA.sessions.forEach(defaultSes => {
            const exists = parsed.sessions.some(s => s.id === defaultSes.id);
            if (!exists) {
              parsed.sessions.push(JSON.parse(JSON.stringify(defaultSes)));
              updated = true;
            }
          });
        }

        if (!parsed.monthlyContributions) { parsed.monthlyContributions = []; updated = true; }
        if (!parsed.transactions || parsed.transactions.length === 0) {
          parsed.transactions = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.transactions || []));
          updated = true;
        }
        if (!parsed.inventory) { parsed.inventory = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.inventory)); updated = true; }
        if (!parsed.clubInfo) { parsed.clubInfo = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.clubInfo)); updated = true; }

        if (updated) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        }

        // Đảm bảo luôn có session đăng nhập nếu chưa từng đăng xuất
        const isExplicitlyLoggedOut = localStorage.getItem('SMASH_PRO_LOGGED_OUT') === 'true';
        const session = localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY);
        if (!session && !isExplicitlyLoggedOut) {
          const defaultAdmin = parsed.users.find(u => u.username === 'admin') || parsed.users[0];
          if (defaultAdmin) {
            const defaultSession = {
              id: defaultAdmin.id,
              username: defaultAdmin.username,
              name: defaultAdmin.name,
              role: defaultAdmin.role,
              memberId: defaultAdmin.memberId,
              loginAt: new Date().toISOString()
            };
            localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(defaultSession));
          }
        }
      }
    } catch (e) {
      console.error("Lỗi khởi tạo schema CSDL:", e);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(PROD_DEFAULT_DATA));
    }
  },

  // Tải toàn bộ CSDL
  loadData() {
    this.ensureDatabaseSchema();
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
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

  // Lưu toàn bộ CSDL và phát sự kiện đồng bộ
  saveData(data, syncToCloud = true) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      window.dispatchEvent(new CustomEvent("app-state-changed", { detail: data }));

      if (syncToCloud && this.googleScriptUrl) {
        this.debouncedCloudSync(data);
      }
    } catch (e) {
      console.error("Lỗi lưu CSDL vào localStorage:", e);
    }
  },

  // ==========================================
  // HỆ THỐNG XÁC THỰC & QUẢN LÝ NGƯỜI DÙNG (AUTH)
  // ==========================================

  // Lấy thông tin tài khoản đang đăng nhập hiện tại
  getCurrentUser() {
    try {
      const session = localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY);
      if (session) {
        const parsed = JSON.parse(session);
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const data = JSON.parse(stored);
          const user = (data.users || []).find(u => u.id === parsed.id || u.username === parsed.username);
          if (user) return user;
        }
      } else {
        const isExplicitlyLoggedOut = localStorage.getItem('SMASH_PRO_LOGGED_OUT') === 'true';
        if (!isExplicitlyLoggedOut) {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (stored) {
            const data = JSON.parse(stored);
            if (data.users && data.users.length > 0) {
              return data.users.find(u => u.username === 'admin') || data.users[0];
            }
          }
          return PROD_DEFAULT_DATA.users[0];
        }
      }
    } catch (e) {
      console.error("Lỗi lấy phiên đăng nhập:", e);
    }
    return null;
  },

  // Kiểm tra trạng thái đã đăng nhập hay chưa
  isLoggedIn() {
    return this.getCurrentUser() !== null;
  },

  // Đăng nhập hệ thống (Mặc định admin/admin)
  login(usernameOrPhone, password, remember = true) {
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

    // Lưu phiên đăng nhập
    const sessionData = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      memberId: user.memberId,
      loginAt: new Date().toISOString()
    };

    localStorage.removeItem('SMASH_PRO_LOGGED_OUT');
    if (remember) {
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
    } else {
      sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
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

    // Lưu phiên đăng nhập
    const sessionData = {
      id: newUser.id,
      username: newUser.username,
      name: newUser.name,
      role: newUser.role,
      memberId: newUser.memberId,
      loginAt: new Date().toISOString()
    };
    localStorage.removeItem('SMASH_PRO_LOGGED_OUT');
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));

    return { 
      success: true, 
      user: newUser, 
      message: `Đăng ký thành công! Tên đăng nhập của bạn là: ${finalUsername}` 
    };
  },

  // Đăng xuất khỏi hệ thống
  logout() {
    localStorage.setItem('SMASH_PRO_LOGGED_OUT', 'true');
    localStorage.removeItem(AUTH_SESSION_KEY);
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    
    // Reset currentUser trong CSDL
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        data.currentUser = null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      }
    } catch (e) {
      console.error("Lỗi xóa phiên trong CSDL:", e);
    }
  },

  // ==========================================
  // CHẾ ĐỘ DỮ LIỆU: PRODUCTION VS TEST DEMO
  // ==========================================
  
  switchDatabaseMode(mode) {
    if (mode === 'test') {
      const testData = JSON.parse(JSON.stringify(TEST_MOCK_DATA));
      testData.currentUser = testData.users[0]; // Admin test
      this.activeSheet = 'CSDL_KiemThu_Test';
      this.saveData(testData, true);
      return testData;
    } else {
      const prodData = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
      prodData.currentUser = prodData.users[0]; // Admin prod
      this.activeSheet = 'CSDL_VanHanh_Prod';
      this.saveData(prodData, true);
      return prodData;
    }
  },

  // ==========================================
  // ĐỒNG BỘ ĐÁM MÂY GOOGLE DRIVE / SHEETS
  // ==========================================

  debouncedCloudSync(data) {
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }
    this.updateSyncBadgeUI('syncing', 'Đang lưu Google Drive...');
    this.syncDebounceTimer = setTimeout(() => {
      this.pushToCloud(data, false);
    }, 800);
  },

  async pushToCloud(data = null, showToast = true) {
    const payload = data || this.loadData();
    // Đính kèm thông tin sheet mục tiêu (Prod / Test)
    payload.sheetName = this.activeSheet;
    this.updateSyncBadgeUI('syncing', 'Đang đồng bộ Google Drive...');

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
      this.updateSyncBadgeUI('synced', `Google Drive: Đã đồng bộ (${this.lastSyncedTime})`);

      if (showToast && window.App) {
        App.showToast(`☁️ Đã đồng bộ CSDL lên Google Sheet (${this.activeSheet}) thành công!`, "success");
      }
      return true;
    } catch (err) {
      console.warn("Cloud push failed, saved locally:", err);
      this.cloudSyncStatus = 'offline';
      this.updateSyncBadgeUI('offline', 'Google Drive: Chế độ offline');
      if (showToast && window.App) {
        App.showToast("⚠️ Không thể kết nối Google Drive, dữ liệu đã lưu an toàn trên máy bạn!", "warning");
      }
      return false;
    }
  },

  async pullFromCloud(showToast = true) {
    this.updateSyncBadgeUI('syncing', 'Đang tải từ Google Drive...');
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

      if (cloudData && cloudData.clubInfo && cloudData.users && cloudData.sessions && cloudData.sessions.length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudData));
        this.lastSyncedTime = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        this.cloudSyncStatus = 'synced';
        this.updateSyncBadgeUI('synced', `Google Drive: Đã đồng bộ (${this.lastSyncedTime})`);
        
        window.dispatchEvent(new CustomEvent("app-state-changed", { detail: cloudData }));
        
        if (showToast && window.App) {
          App.showToast(`☁️ Đã nạp CSDL từ Google Sheet (${this.activeSheet})!`, "success");
        }
        return cloudData;
      } else {
        console.log("Khởi tạo dữ liệu ban đầu lên Google Drive...");
        await this.pushToCloud(this.loadData(), false);
        return this.loadData();
      }
    } catch (err) {
      console.warn("Không thể tải từ Google Drive, sử dụng CSDL cục bộ:", err);
      this.cloudSyncStatus = 'offline';
      this.updateSyncBadgeUI('offline', 'Google Drive: Offline');
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
