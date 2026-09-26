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

  // Đảm bảo cấu trúc CSDL hợp lệ
  ensureDatabaseSchema() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        // Khởi tạo mặc định CSDL Vận hành thực tế (Production)
        const initialProd = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
        initialProd.currentUser = null; // Mặc định chế độ Khách vãng lai
        initialProd.lastModified = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initialProd));
      } else {
        const parsed = JSON.parse(stored);
        let updated = false;

        // Tự động nâng cấp schema và dọn dẹp dữ liệu mẫu phiên bản cũ
        if (parsed.version !== PROD_DEFAULT_DATA.version || 
            (Array.isArray(parsed.members) && parsed.members.some(m => m.id === 'mem_2' || m.id === 'mem_3' || m.id === 'mem_admin'))) {
          parsed.version = PROD_DEFAULT_DATA.version;
          
          if (Array.isArray(parsed.members)) {
            parsed.members = parsed.members.filter(m => m.id !== 'mem_2' && m.id !== 'mem_3' && m.id !== 'mem_admin');
          }
          if (Array.isArray(parsed.monthlyContributions)) {
            parsed.monthlyContributions = parsed.monthlyContributions.filter(d => d.memberId !== 'mem_2' && d.memberId !== 'mem_3' && d.memberId !== 'mem_admin');
          }
          if (Array.isArray(parsed.sessions)) {
            parsed.sessions.forEach(s => {
              if (Array.isArray(s.votes)) {
                s.votes = s.votes.filter(v => v.memberId !== 'mem_2' && v.memberId !== 'mem_3' && v.memberId !== 'mem_admin');
              }
            });
          }
          if (Array.isArray(parsed.users)) {
            parsed.users = parsed.users.filter(u => u.username !== 'maianh' && u.username !== 'hoanglong' && u.id !== 'user_mem2');
          }
          parsed.lastModified = Date.now();
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

        if (!parsed.members || !Array.isArray(parsed.members)) {
          parsed.members = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.members || []));
          updated = true;
        }

        // Khởi tạo danh sách buổi đánh nếu chưa có trong CSDL
        if (!parsed.sessions || !Array.isArray(parsed.sessions)) {
          parsed.sessions = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.sessions || []));
          updated = true;
        }

        if (!parsed.monthlyContributions || !Array.isArray(parsed.monthlyContributions)) { 
          parsed.monthlyContributions = []; 
          updated = true; 
        }
        if (!parsed.transactions || !Array.isArray(parsed.transactions)) {
          parsed.transactions = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.transactions || []));
          updated = true;
        }
        if (!parsed.inventory) { parsed.inventory = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.inventory)); updated = true; }
        if (!parsed.clubInfo) { parsed.clubInfo = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA.clubInfo)); updated = true; }

        if (updated) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
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
      data.lastModified = Date.now();
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

  // Kiểm tra quyền Khách vãng lai
  isGuest() {
    return !this.isLoggedIn();
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
  // CHẾ ĐỘ DỮ LIỆU: PRODUCTION VS TEST DEMO
  // ==========================================
  
  switchDatabaseMode(mode) {
    if (mode === 'test') {
      const testData = JSON.parse(JSON.stringify(TEST_MOCK_DATA));
      testData.currentUser = this.getCurrentUser();
      this.activeSheet = 'CSDL_KiemThu_Test';
      this.saveData(testData, true);
      return testData;
    } else {
      const prodData = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
      prodData.currentUser = this.getCurrentUser();
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

      if (cloudData && cloudData.clubInfo && cloudData.users && Array.isArray(cloudData.sessions)) {
        // Tự động chuẩn hóa dữ liệu đám mây nếu chứa dữ liệu mẫu hoặc phiên bản cũ
        let cloudNeedsClean = false;
        if (cloudData.version !== PROD_DEFAULT_DATA.version || 
            (Array.isArray(cloudData.members) && cloudData.members.some(m => m.id === 'mem_2' || m.id === 'mem_3' || m.id === 'mem_admin'))) {
          cloudData.version = PROD_DEFAULT_DATA.version;
          if (Array.isArray(cloudData.members)) {
            cloudData.members = cloudData.members.filter(m => m.id !== 'mem_2' && m.id !== 'mem_3' && m.id !== 'mem_admin');
          }
          if (Array.isArray(cloudData.monthlyContributions)) {
            cloudData.monthlyContributions = cloudData.monthlyContributions.filter(d => d.memberId !== 'mem_2' && d.memberId !== 'mem_3' && d.memberId !== 'mem_admin');
          }
          if (Array.isArray(cloudData.sessions)) {
            cloudData.sessions.forEach(s => {
              if (Array.isArray(s.votes)) {
                s.votes = s.votes.filter(v => v.memberId !== 'mem_2' && v.memberId !== 'mem_3' && v.memberId !== 'mem_admin');
              }
            });
          }
          if (Array.isArray(cloudData.users)) {
            cloudData.users = cloudData.users.filter(u => u.username !== 'maianh' && u.username !== 'hoanglong' && u.id !== 'user_mem2');
          }
          cloudData.lastModified = Date.now();
          cloudNeedsClean = true;
        }

        // Kiểm tra timestamp để tránh việc đám mây cũ ghi đè dữ liệu mới xóa/thay đổi tại local
        const localStored = localStorage.getItem(STORAGE_KEY);
        let localMod = 0;
        if (localStored) {
          try {
            const parsedLocal = JSON.parse(localStored);
            localMod = parsedLocal.lastModified || 0;
          } catch(e) {}
        }
        const cloudMod = cloudData.lastModified || 0;

        if (!cloudNeedsClean && localMod > cloudMod && (localMod - cloudMod) > 500) {
          console.log("[CloudSync] Dữ liệu local mới hơn Cloud. Đẩy local lên Google Drive...");
          const localData = this.loadData();
          await this.pushToCloud(localData, false);
          return localData;
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudData));
        this.lastSyncedTime = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        this.cloudSyncStatus = 'synced';
        this.updateSyncBadgeUI('synced', `Google Drive: Đã đồng bộ (${this.lastSyncedTime})`);
        
        window.dispatchEvent(new CustomEvent("app-state-changed", { detail: cloudData }));
        
        if (cloudNeedsClean) {
          console.log("[CloudSync] Đã dọn dẹp dữ liệu cũ trên Cloud, đồng bộ phiên bản sạch 2.1_PROD...");
          await this.pushToCloud(cloudData, false);
        }

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
