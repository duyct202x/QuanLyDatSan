// Storage & Authentication Manager for SMASH PRO
// Lưu trữ cục bộ (IndexedDB qua LocalDB), Xác thực tài khoản & Đồng bộ Cloud v2
//
// Kiến trúc đồng bộ v2 (local-first):
//  1. Mỗi lần lưu: so sánh dữ liệu với bản lúc loadData() -> sinh "op" chỉ chứa TRƯỜNG thực sự thay đổi.
//  2. Op được ghi ngay vào hàng đợi (outbox) trên thiết bị -> không mất dù mất mạng hay đóng tab.
//  3. Giao diện hiển thị = bản đã xác nhận từ máy chủ + các op đang chờ (cập nhật tức thì, kể cả offline).
//  4. Đồng bộ: gửi op + nhận về các bản ghi thay đổi sau SEQ đã biết (delta) trong cùng một request.
//  5. Máy chủ hợp nhất theo từng trường bằng đồng hồ HLC -> máy cũ không ghi đè dữ liệu mới của máy khác.

const STORAGE_KEY = "SMASH_PRO_BADMINTON_APP_V2"; // CSDL kiểu v1 - chỉ đọc để chuyển sang v2
const AUTH_SESSION_KEY = "SMASH_PRO_AUTH_SESSION_V2";
const ACTIVE_SHEET_KEY = "SMASH_PRO_ACTIVE_SHEET_V2";
const DEVICE_ID_KEY = "SMASH_PRO_DEVICE_ID";
const LEGACY_MIGRATED_KEY = "SMASH_PRO_V2_MIGRATED";
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec";

const AppStorage = {
  googleScriptUrl: GOOGLE_SCRIPT_URL,
  cloudSyncStatus: 'idle', // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
  lastSyncedTime: null,
  activeSheet: 'CSDL_VanHanh_Prod', // 'CSDL_VanHanh_Prod' | 'CSDL_KiemThu_Test'

  POLL_INTERVAL: 10000,      // Kiểm tra thay đổi từ máy khác (chỉ khi tab đang hiển thị)
  REQUEST_TIMEOUT: 30000,
  MAX_BATCH_OPS: 100,
  MAX_BATCH_CHARS: 2000000,
  BEACON_LIMIT: 60000,
  MASS_DELETE_MIN: 10,       // Chặn lệnh xóa hàng loạt bất thường (lỗi lập trình) trong 1 lần lưu
  BACKUP_INTERVAL: 60 * 60 * 1000,

  isTestEnvironment() {
    try {
      if (window.__IS_TEST_ENV__ === true) return true;
      if (window.location && (window.location.search.includes('test=true') || window.location.search.includes('test=1') || window.location.search.includes('is_test=true'))) return true;
    } catch(e) {}
    return false;
  },

  getActiveSheet() {
    if (this.isTestEnvironment()) {
      return 'CSDL_KiemThu_Test';
    }
    return localStorage.getItem(ACTIVE_SHEET_KEY) || 'CSDL_VanHanh_Prod';
  },

  // Không gửi lên Cloud (môi trường kiểm thử hoặc chưa cấu hình URL): op áp thẳng vào kho cục bộ
  isLocalOnly() {
    return this.isTestEnvironment() || !this.googleScriptUrl;
  },

  // ==========================================
  // TRẠNG THÁI ĐỒNG BỘ v2
  // ==========================================
  _env: null,
  _confirmed: {},     // recKey -> bản ghi đã được máy chủ xác nhận
  _working: {},       // = _confirmed + các op trong outbox (hiển thị lạc quan)
  _outbox: [],        // op chưa được máy chủ xác nhận (theo thứ tự)
  _meta: { lastSeq: 0, clockOffset: 0, lastBackupAt: 0 },
  _viewJson: null,
  _viewObj: null,
  _loadedBase: new WeakMap(), // data object -> chuỗi JSON lúc được loadData() trả về
  _clock: null,
  _opCounter: 0,
  _ready: null,
  _syncPromise: null,
  _syncTimer: null,
  _pollTimer: null,
  _syncAgain: false,
  _syncFull: false,
  _failCount: 0,
  _channel: null,
  _listenersInstalled: false,

  _ns() {
    return (typeof window !== 'undefined' && window.__SMASH_DEVICE_NS__) || '';
  },

  deviceId() {
    const key = this._ns() + DEVICE_ID_KEY;
    let id = localStorage.getItem(key);
    if (!id) {
      id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(key, id);
    }
    return id;
  },

  // Khởi tạo hệ thống lưu trữ & đồng bộ (trả về Promise - App phải chờ trước khi hiển thị dữ liệu)
  init() {
    if (!this._ready) this._ready = this._init();
    return this._ready;
  },

  async _init() {
    this.activeSheet = this.getActiveSheet();
    this._clock = SyncCore.createClock(this.deviceId());
    try {
      await this._loadEnv(this.activeSheet);
      await this._migrateLegacyV1();
    } catch (e) {
      console.error('[Storage] Lỗi khởi tạo kho cục bộ:', e);
    }
    this._installListeners();
    this._pruneTokens();
    this._refreshBadge();
    this.requestSync(0);
  },

  async _loadEnv(env) {
    this._env = env;
    const { records, meta } = await LocalDB.loadEnv(env);
    this._confirmed = records;
    this._meta = {
      lastSeq: Number(meta.lastSeq) || 0,
      viewer: meta.viewer || '',
      scope: meta.scope || '',
      clockOffset: Number(meta.clockOffset) || 0,
      lastBackupAt: Number(meta.lastBackupAt) || 0
    };
    this._outbox = LocalDB.loadOutbox(env, meta.outbox);
    this._opCounter = this._outbox.reduce((m, op) => Math.max(m, op.n || 0), 0);
    this._clock.setOffset(this._meta.clockOffset);
    Object.keys(records).forEach((rk) => this._clock.observe(SyncCore.recordHlcMax(records[rk])));
    this._outbox.forEach((op) => this._clock.observe(op.h));
    this._rebuildWorking();
  },

  // Chuyển CSDL kiểu v1 (1 khối JSON trong localStorage) sang kho v2 - chạy 1 lần trên mỗi thiết bị
  async _migrateLegacyV1() {
    const flagKey = this._ns() + LEGACY_MIGRATED_KEY;
    if (localStorage.getItem(flagKey)) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    let legacy = null;
    try { legacy = raw ? JSON.parse(raw) : null; } catch (e) {}
    const pending = localStorage.getItem(`SMASH_PRO_PENDING_PUSH_${this._env}`) === '1';

    // Giải phóng localStorage (v1 giữ tới 7 bản sao toàn bộ CSDL -> dễ đầy bộ nhớ và lưu thất bại âm thầm)
    [STORAGE_KEY, 'SMASH_PRO_AUTO_BACKUP_PRIMARY', 'SMASH_PRO_AUTO_BACKUP_HISTORY',
      'SMASH_PRO_PENDING_PUSH_CSDL_VanHanh_Prod', 'SMASH_PRO_PENDING_PUSH_CSDL_KiemThu_Test',
      'SMASH_PRO_CLOUD_REV_CSDL_VanHanh_Prod', 'SMASH_PRO_CLOUD_REV_CSDL_KiemThu_Test'
    ].forEach((k) => localStorage.removeItem(k));

    if (legacy && !legacy.isInitialSkeleton && typeof legacy === 'object') {
      delete legacy.currentUser;
      if (!Object.keys(this._confirmed).length && !this._meta.lastSeq) {
        // Dùng tạm dữ liệu cũ để làm việc offline; lần tải đầy đủ đầu tiên từ máy chủ sẽ thay thế
        const recs = {};
        SyncCore.applyOps(recs, SyncCore.legacySnapshotToOps(legacy, 'legacy'));
        this._confirmed = recs;
        await LocalDB.write(this._env, { allRecords: recs, replaceAll: true, meta: { legacyBackup: raw } });
      } else {
        await LocalDB.write(this._env, { meta: { legacyBackup: raw } });
      }
      // Thay đổi v1 chưa kịp gửi: gửi nguyên ảnh chụp, máy chủ hợp nhất theo từng trường (không đè dữ liệu mới hơn)
      if (pending && !this.isLocalOnly()) {
        this._enqueue([{ t: 'legacy', snap: legacy }], false);
      } else {
        this._rebuildWorking();
      }
    }
    localStorage.setItem(flagKey, '1');
  },

  _installListeners() {
    if (this._listenersInstalled || typeof window === 'undefined') return;
    this._listenersInstalled = true;
    window.addEventListener('online', () => this.requestSync(0));
    window.addEventListener('offline', () => this._refreshBadge('offline'));
    window.addEventListener('focus', () => this.requestSync(0));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.requestSync(0);
      else this._flushBeacon();
    });
    window.addEventListener('pagehide', () => this._flushBeacon());

    // Đồng bộ giữa nhiều tab trên cùng thiết bị
    if (typeof BroadcastChannel !== 'undefined') {
      this._channel = new BroadcastChannel(this._ns() + 'smash-pro-sync-v2');
      this._channel.onmessage = (ev) => {
        if (!ev.data || ev.data.env !== this._env || ev.data.from === this._tabId) return;
        this._loadEnv(this._env).then(() => this._emitChanged()).catch(() => {});
      };
    }
  },

  _tabId: Math.random().toString(36).slice(2),

  _broadcast() {
    try { if (this._channel) this._channel.postMessage({ env: this._env, from: this._tabId }); } catch (e) {}
  },

  // ==========================================
  // KHO & GIAO DIỆN DỮ LIỆU
  // ==========================================
  _cloneRec(r) {
    return { d: Object.assign({}, r.d), f: Object.assign({}, r.f), x: r.x || '', c: r.c || '', s: r.s || 0 };
  },

  // Áp op lên bản làm việc, sao chép bản ghi trước khi sửa để không đụng vào _confirmed
  _applyToWorking(w, ops, owned) {
    const own = (rk) => {
      if (owned.has(rk)) return;
      if (w[rk]) w[rk] = this._cloneRec(w[rk]);
      owned.add(rk);
    };
    ops.forEach((op) => {
      if (op.t === 'legacy') {
        this._applyToWorking(w, SyncCore.legacySnapshotToOps(op.snap, 'legacy'), owned);
      } else if (op.t === 'reset') {
        Object.keys(w).forEach(own);
        SyncCore.applyOps(w, [op]);
      } else {
        own(SyncCore.recKey(op.col, String(op.key)));
        SyncCore.applyOps(w, [op]);
      }
    });
  },

  _rebuildWorking() {
    const w = Object.assign({}, this._confirmed);
    this._ownedWorking = new Set();
    this._applyToWorking(w, this._outbox, this._ownedWorking);
    this._working = w;
    this._invalidateView();
  },

  _invalidateView() {
    this._viewJson = null;
    this._viewObj = null;
  },

  // Dữ liệu dạng ứng dụng (đã chuẩn hóa) - được đệm lại, chỉ dựng lại khi kho thay đổi
  _getViewJson() {
    if (this._viewJson) return this._viewJson;
    const defaults = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
    const neverSynced = !this._meta.lastSeq && !Object.keys(this._working).length;
    let data = defaults;
    if (!neverSynced) {
      const built = SyncCore.buildCollections(this._working);
      data = Object.assign({}, defaults, built);
      data.clubInfo = Object.assign({}, defaults.clubInfo, built.clubInfo || {});
    }
    data.currentUser = null;
    data.mode = 'production';
    data.sheetName = this._env || this.activeSheet;
    data.lastModified = this._meta.lastSeq;
    data.isInitialSkeleton = neverSynced;
    data.deletedMemberIds = [];
    data.deletedUserIds = [];
    this.sanitizeProductionData(data);
    this.reconcileUsersAndMembers(data);
    data.currentUser = null;
    this._viewJson = JSON.stringify(data);
    return this._viewJson;
  },

  _getViewObj() {
    if (!this._viewObj) this._viewObj = JSON.parse(this._getViewJson());
    return this._viewObj;
  },

  _emitChanged() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent("app-state-changed", { detail: this.loadData() }));
  },

  // Tương thích mã cũ: cấu trúc CSDL nay được bảo đảm khi dựng dữ liệu hiển thị
  ensureDatabaseSchema() {},

  // 1. Kiểm tra và làm sạch đối tượng hỏng kỹ thuật & rác kiểm thử (Bảo vệ 100% bản ghi người dùng hợp lệ)
  sanitizeProductionData(data) {
    if (!data) return data;
    if (typeof data !== 'object') return data;
    const isTest = this.isTestEnvironment();
    const deletedMemberIds = new Set(Array.isArray(data.deletedMemberIds) ? data.deletedMemberIds : []);
    const deletedUserIds = new Set(Array.isArray(data.deletedUserIds) ? data.deletedUserIds : []);

    // Lọc users: Giữ lại toàn bộ tài khoản hợp lệ, khử trùng lặp và loại bỏ tài khoản kiểm thử rác hoặc đã bị xóa
    if (Array.isArray(data.users)) {
      const isTestUser = (u) => {
        if (!u || (!u.id && !u.username)) return true;
        const id = String(u.id || '');
        const un = String(u.username || '').toLowerCase();
        if (un === 'admin' || id === 'user_admin') return false; // Luôn giữ admin
        if (deletedUserIds.has(id) || deletedUserIds.has(un) || (u.memberId && deletedMemberIds.has(u.memberId))) return true;
        if (isTest) return false;
        // Danh sách ID/Username test hoặc giả định cần loại trừ tận gốc
        const mockUserIds = new Set([
          'user_maianh', 'user_hoanglong', 'user_minhduc', 'user_thaovy', 'user_giahuy', 
          'user_thanhson', 'user_tuyetnhi', 'user_tuankiet', 'user_baohung', 'user_dcatrus', 
          'user_baonam', 'user_vanhau', 'user_regular', 'u_regular', 'user_audit_1', 
          'user_quanghien', 'user_vihieu', 'user_tuannv', 'user_1790479550427'
        ]);
        const mockUsernames = new Set([
          'maianh', 'hoanglong', 'minhduc', 'thaovy', 'giahuy', 'thanhson', 'tuyetnhi', 
          'tuankiet', 'baohung', 'dcatrus', 'baonam', 'vanhau', 'quanghien', 'vihieu', 
          'tuannv', '0912345678', 'test_garbage', 'thanhvien1'
        ]);
        if (id.startsWith('user_test_') || mockUserIds.has(id)) return true;
        if (un.startsWith('test_user_') || un.startsWith('test_') || mockUsernames.has(un)) return true;
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

    // Lọc members: Giữ lại toàn bộ thành viên hợp lệ, khử trùng lặp và loại bỏ thành viên kiểm thử rác hoặc đã bị xóa
    if (Array.isArray(data.members)) {
      const isTestMember = (m) => {
        if (!m || (!m.id && !m.name && !m.phone)) return true;
        const id = String(m.id || '');
        const un = String(m.username || '').toLowerCase();
        if (id === 'mem_admin' || un === 'admin') return false; // Luôn giữ admin
        if (deletedMemberIds.has(id) || (m.username && deletedUserIds.has(m.username))) return true;
        if (isTest) return false;
        // Danh sách ID/Username test hoặc giả định cần loại trừ tận gốc
        const mockMemberIds = new Set([
          'mem_maianh', 'mem_hoanglong', 'mem_minhduc', 'mem_thaovy', 'mem_giahuy', 
          'mem_thanhson', 'mem_tuyetnhi', 'mem_tuankiet', 'mem_baohung', 'mem_1790412027160', 
          'mem_1790414367290', 'mem_vanhau', 'mem_regular', 'mem_audit_user', 'mem_quanghien', 
          'mem_vihieu', 'mem_tuannv', 'mem_1790479550427'
        ]);
        const mockUsernames = new Set([
          'maianh', 'hoanglong', 'minhduc', 'thaovy', 'giahuy', 'thanhson', 'tuyetnhi', 
          'tuankiet', 'baohung', 'dcatrus', 'baonam', 'vanhau', 'quanghien', 'vihieu', 
          'tuannv', '0912345678', 'thanhvien1'
        ]);
        if (id.startsWith('mem_test_') || mockMemberIds.has(id)) return true;
        if (un.startsWith('test_') || mockUsernames.has(un) || (m.name === 'Nguyễn Văn Thành Viên' && m.phone === '0933112233')) return true;
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

    // Lọc sessions: Bảo toàn 100% ca đánh hợp lệ, loại bỏ ca đánh rác kiểm thử hoặc mẫu giả định
    if (Array.isArray(data.sessions)) {
      data.sessions = data.sessions.filter(s => {
        if (!s || !s.id) return false;
        if (isTest) return true;
        const id = String(s.id);
        if (id.startsWith('session_test_') || id.startsWith('ses_test_') || id === 'ses_1790413607618') return false;
        return true;
      });
    } else {
      data.sessions = [];
    }

    // Lọc monthlyContributions: Bảo toàn 100% bản ghi đóng quỹ hợp lệ (thuộc thành viên hiện có)
    // NGHIÊM NGẶT: Chống tự ý ghi nhận 'paid' khi không có chứng từ/giao dịch thực tế
    const validMemberIds = new Set(data.members.map(m => m.id));
    const txDueIds = new Set((data.transactions || []).filter(t => t && t.dueId).map(t => t.dueId));
    if (Array.isArray(data.monthlyContributions)) {
      data.monthlyContributions = data.monthlyContributions.filter(d => d && d.memberId && validMemberIds.has(d.memberId)).map(d => {
        // Nếu bản ghi ghi nhận paid nhưng không có biên lai VÀ không có giao dịch trong Sổ quỹ -> Đặt lại unpaid
        if (d.status === 'paid' && !d.billImage && !txDueIds.has(d.id)) {
          return {
            ...d,
            status: 'unpaid',
            paidAt: null,
            method: null,
            billImage: null,
            approvedBy: null,
            approvedAt: null,
            note: 'Chưa đóng'
          };
        }
        return d;
      });
    } else {
      data.monthlyContributions = [];
    }

    // Lọc transactions: Bảo toàn 100% giao dịch sổ quỹ hợp lệ do người dùng tạo, loại bỏ triệt để probe, rác kiểm thử & giao dịch mẫu giả định
    if (Array.isArray(data.transactions)) {
      const mockTxIds = new Set(['tx_prod_1', 'tx_prod_2', 'tx_prod_3', 'tx_prod_4', 'tx_prod_5', 'tx_prod_6', 'tx_1790446297818']);
      const isGarbageTx = (t) => {
        if (!t || !t.id) return true;
        if (isTest) return false;
        const strId = String(t.id);
        const title = (t.title || t.description || '').toLowerCase().trim();
        if (mockTxIds.has(strId)) return true;
        if (strId.startsWith('realtime_audit_probe_') || strId.startsWith('tx_test_') || strId === 'tx_1790423944296' || strId === 'tx_test_garbage') return true;
        if (title === 'cxasxa' || title === 's' || title === '' || t.category === 'audit_probe') return true;
        if (typeof t.amount !== 'number' || isNaN(t.amount) || t.amount <= 0) return true;
        if (t.type !== 'income' && t.type !== 'expense') return true;
        return false;
      };
      data.transactions = data.transactions.filter(t => !isGarbageTx(t));
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

    // Đồng bộ từng user với member (mật khẩu chỉ nằm trên máy chủ, không tự gán mật khẩu mặc định)
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
            amount: data.clubInfo?.monthlyFee || data.clubInfo?.monthlyFundFee || 20000,
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

    // 5. Làm sạch triệt để các giao dịch rác thử nghiệm & Khử trùng lặp thu quỹ tháng
    if (Array.isArray(data.transactions)) {
      const isTest = this.isTestEnvironment();
      const isGarbageTx = (t) => {
        if (!t || !t.id) return true;
        if (isTest) return false;
        const strId = String(t.id);
        const title = (t.title || t.description || '').toLowerCase().trim();
        if (strId.startsWith('realtime_audit_probe_') || strId.startsWith('tx_test_') || strId === 'tx_1790423944296' || strId === 'tx_test_garbage') return true;
        if (title === 'cxasxa' || title === 's' || title === '' || t.category === 'audit_probe') return true;
        if (typeof t.amount !== 'number' || isNaN(t.amount) || t.amount <= 0) return true;
        if (t.type !== 'income' && t.type !== 'expense') return true;
        return false;
      };
      data.transactions = data.transactions.filter(t => !isGarbageTx(t));

      // Khử trùng lặp giao dịch thu quỹ theo dueId (1 dueId chỉ có duy nhất 1 bản ghi thu quỹ)
      const dueTxMap = new Map();
      const cleanTxs = [];
      data.transactions.forEach(t => {
        if (t.dueId) {
          if (!dueTxMap.has(t.dueId)) {
            dueTxMap.set(t.dueId, t);
            cleanTxs.push(t);
          }
        } else {
          cleanTxs.push(t);
        }
      });
      data.transactions = cleanTxs;
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

  // Tải toàn bộ CSDL (bản sao riêng - module được phép sửa rồi gọi saveData)
  loadData() {
    const json = this._getViewJson();
    const parsed = JSON.parse(json);
    parsed.currentUser = this.getCurrentUser();
    this._loadedBase.set(parsed, json); // Mốc so sánh để saveData chỉ gửi phần thay đổi
    return parsed;
  },

  // Sinh op từ thay đổi của người dùng và đưa vào hàng đợi. Trả về danh sách op.
  commitLocal(data, { sync = true } = {}) {
    if (!data || typeof data !== 'object') return [];
    const baseJson = this._loadedBase.get(data) || this._getViewJson();
    const base = JSON.parse(baseJson);
    const h = this._clock ? this._clock.now() : SyncCore.hlcPack(Date.now(), 0, 'boot');
    let ops = SyncCore.diffData(base, data, h, (col, key) => !!this._working[SyncCore.recKey(col, key)]);

    // Chốt chặn: một lần lưu xóa quá nửa bộ sưu tập (>= 10 bản ghi) gần như chắc chắn là lỗi -> bỏ lệnh xóa
    SyncCore.COLLECTIONS.forEach((col) => {
      const dels = ops.filter((o) => o.col === col && o.t === 'del');
      const total = Array.isArray(base[col]) ? base[col].length : 0;
      if (dels.length >= this.MASS_DELETE_MIN && dels.length * 2 > total) {
        console.error(`[Storage] Chặn xóa hàng loạt ${dels.length}/${total} bản ghi "${col}" trong một lần lưu.`);
        ops = ops.filter((o) => !(o.col === col && o.t === 'del'));
        if (window.App) App.showToast(`⚠️ Đã chặn thao tác xóa hàng loạt bất thường (${col}). Dữ liệu được giữ nguyên.`, "warning");
      }
    });

    // Lần lưu tiếp theo trên cùng đối tượng chỉ so với trạng thái vừa lưu
    this._loadedBase.set(data, JSON.stringify(data));
    if (!ops.length) return [];
    this._enqueue(ops, sync);
    return ops;
  },

  _enqueue(ops, sync = true) {
    ops.forEach((op) => {
      this._opCounter++;
      op.id = `${this.deviceId()}_${Date.now().toString(36)}_${this._opCounter}`;
      op.n = this._opCounter;
      op.u = this._currentUsername();
    });

    if (this.isLocalOnly()) {
      const changed = {};
      const expanded = [];
      ops.forEach((op) => {
        if (op.t === 'legacy') expanded.push(...SyncCore.legacySnapshotToOps(op.snap, 'legacy'));
        else expanded.push(op);
      });
      SyncCore.applyOps(this._confirmed, expanded).forEach((rk) => { changed[rk] = this._confirmed[rk]; });
      LocalDB.write(this._env, { records: changed }).catch((e) => console.error('[Storage] Lỗi lưu cục bộ:', e));
      this._rebuildWorking();
    } else {
      this._outbox.push(...ops);
      const durable = LocalDB.saveOutbox(this._env, this._outbox);
      if (!durable && !LocalDB._db && window.App) {
        App.showToast("⚠️ Bộ nhớ trình duyệt đã đầy, thay đổi chưa được lưu bền vững. Hãy kết nối mạng để đồng bộ ngay!", "error");
      }
      this._applyToWorking(this._working, ops, this._ownedWorking || (this._ownedWorking = new Set()));
      this._invalidateView();
    }

    this._emitChanged();
    this._broadcast();
    this._refreshBadge();
    if (sync) this.requestSync(300);
  },

  // Lưu toàn bộ CSDL: ghi nhận ngay trên thiết bị, tự đồng bộ nền khi có mạng
  saveData(data, syncToCloud = true) {
    try {
      this.commitLocal(data, { sync: syncToCloud });
    } catch (e) {
      console.error("Lỗi lưu CSDL:", e);
      if (window.App) App.showToast("❌ Không thể lưu thay đổi: " + e.message, "error");
    }
  },

  // Lưu CSDL và chờ máy chủ xác nhận (Two-Phase Cloud Sync Acknowledgment)
  async saveDataWithCloudAck(data, options = {}) {
    try {
      const ops = this.commitLocal(data, { sync: false });
      if (this.isLocalOnly()) {
        return { success: true, isTest: true, message: "Đã lưu an toàn (Chế độ Test/Offline)" };
      }
      const ids = new Set(ops.map((o) => o.id));
      await this.syncNow();
      const stillPending = this._outbox.some((o) => ids.has(o.id));
      if (!stillPending) {
        return {
          success: true,
          message: "Đã ghi nhận và lưu vĩnh viễn vào CSDL Cloud!",
          lastSyncedTime: this.lastSyncedTime
        };
      }
      return {
        success: false,
        error: "Không thể kết nối máy chủ database",
        message: "Dữ liệu đã được lưu an toàn trên máy bạn và sẽ tự đồng bộ khi có mạng."
      };
    } catch (e) {
      console.error("Lỗi saveDataWithCloudAck:", e);
      return { success: false, error: e.message, message: "Lỗi xử lý dữ liệu: " + e.message };
    }
  },

  // ==========================================
  // HỆ THỐNG XÁC THỰC & QUẢN LÝ NGƯỜI DÙNG (AUTH)
  // Mật khẩu chỉ được kiểm tra trên máy chủ. Máy chủ cấp token (ký HMAC); mọi thay đổi gửi lên phải kèm token
  // và được máy chủ kiểm quyền. Trình duyệt không còn giữ/so khớp mật khẩu của bất kỳ ai.
  // ==========================================

  // Thời gian hết hạn do không hoạt động (15 phút)
  INACTIVITY_TIMEOUT: 15 * 60 * 1000,
  // Thời gian sống của phiên khi tick "Ghi nhớ" (24 giờ)
  SESSION_REMEMBER_TTL: 24 * 60 * 60 * 1000,
  // Thời gian sống của phiên tạm thời khi không tick "Ghi nhớ" (2 giờ)
  SESSION_TEMP_TTL: 2 * 60 * 60 * 1000,

  _authKey() {
    return this._ns() + AUTH_SESSION_KEY;
  },

  _readSession() {
    try {
      const raw = sessionStorage.getItem(this._authKey()) || localStorage.getItem(this._authKey());
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  _writeSession(session) {
    const key = this._authKey();
    if (session.remember) {
      localStorage.setItem(key, JSON.stringify(session));
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, JSON.stringify(session));
      localStorage.removeItem(key);
    }
  },

  // ---- Token theo tài khoản (giữ lại tới khi các thay đổi chờ gửi của tài khoản đó đã đồng bộ xong) ----
  _tokensKey() {
    return this._ns() + 'SMASH_PRO_TOKENS_V2';
  },
  _getTokens() {
    try { return JSON.parse(localStorage.getItem(this._tokensKey()) || '{}') || {}; } catch (e) { return {}; }
  },
  _setTokens(map) {
    if (Object.keys(map).length) localStorage.setItem(this._tokensKey(), JSON.stringify(map));
    else localStorage.removeItem(this._tokensKey());
  },
  _tokenValid(token) {
    const p = AuthCore.readToken(token);
    return !!(p && Number(p.exp) > Date.now());
  },
  // Bỏ token của tài khoản không còn đăng nhập và không còn thay đổi chờ gửi
  _pruneTokens() {
    const session = this._readSession();
    const active = session && session.username;
    const pendingUsers = new Set(this._outbox.map((op) => op.u).filter(Boolean));
    const map = this._getTokens();
    Object.keys(map).forEach((u) => {
      if ((u !== active && !pendingUsers.has(u)) || !this._tokenValid(map[u])) delete map[u];
    });
    this._setTokens(map);
  },

  _currentUsername() {
    const s = this._readSession();
    return s && s.username ? s.username : null;
  },

  // Lấy thông tin tài khoản đang đăng nhập hiện tại (An toàn, kiểm tra TTL, Inactivity & token máy chủ)
  getCurrentUser() {
    try {
      const session = this._readSession();
      if (!session) return null; // Chế độ Khách vãng lai (Guest)
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

      // 3. Phiên phải do máy chủ cấp (phiên cũ trước bản cập nhật bảo mật -> đăng nhập lại)
      if (!this.isLocalOnly() && !this._tokenValid(session.token)) {
        console.warn("[Auth] Phiên không có token hợp lệ từ máy chủ. Vui lòng đăng nhập lại.");
        this.logout(false);
        return null;
      }

      // 4. Truy vấn thông tin người dùng trong CSDL
      const view = this._getViewObj();
      const user = (view.users || []).find(u => u.id === session.id || u.username === session.username);
      if (user) {
        const copy = JSON.parse(JSON.stringify(user));
        delete copy.password;
        delete copy.pwv;
        return copy;
      }
      // Vừa đăng nhập/đăng ký, dữ liệu chưa tải về kịp: dùng thông tin máy chủ trả về lúc đăng nhập
      if (session.user) return JSON.parse(JSON.stringify(session.user));
    } catch (e) {
      console.error("Lỗi xác thực phiên đăng nhập:", e);
    }
    return null;
  },

  // Tài khoản đang dùng mật khẩu yếu -> bắt buộc đổi trước khi được ghi dữ liệu
  mustChangePassword() {
    const s = this._readSession();
    return !!(s && s.mustChange && this.getCurrentUser());
  },

  // Cập nhật timestamp hoạt động người dùng (Gia hạn thời gian Inactivity)
  touchActivity() {
    try {
      const session = this._readSession();
      if (!session) return;
      session.lastActivity = Date.now();
      this._writeSession(session);
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

  // ==========================================
  // MẬT KHẨU (băm/kiểm tra dùng AuthCore - dùng chung với máy chủ)
  // ==========================================
  sha256(ascii) {
    return AuthCore.sha256(ascii);
  },

  // Băm phía trình duyệt trước khi gửi trong dữ liệu (máy chủ sẽ băm lặp có muối thêm một lần nữa)
  hashPassword(password) {
    if (!password) return "";
    const str = String(password).trim();
    if (/^\$sha256\$[0-9a-f]{64}$/.test(str)) return str;
    return AuthCore.canonical(str);
  },

  // Chỉ dùng cho chế độ Test (không có máy chủ). KHÔNG có bất kỳ mật khẩu dự phòng nào.
  verifyPassword(inputPassword, storedPassword) {
    return AuthCore.verify(storedPassword, inputPassword).ok;
  },

  _passwordPolicyError(pwd, confirm) {
    if (pwd.length < 6) return "Mật khẩu bắt buộc phải có độ dài tối thiểu từ 6 ký tự trở lên!";
    if (/\s/.test(pwd)) return "Mật khẩu không được chứa khoảng trắng!";
    if (confirm !== undefined && pwd !== String(confirm).trim()) return "Mật khẩu xác nhận không khớp, vui lòng kiểm tra lại!";
    return null;
  },

  async _authRequest(body) {
    const url = `${this.googleScriptUrl}?sheet=${encodeURIComponent(this._env || this.getActiveSheet())}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({ v: 2, sheet: this._env || this.getActiveSheet() }, body))
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.status === 'error') return { status: 'error', message: json.message || 'Máy chủ trả lỗi' };
      return json;
    } catch (e) {
      console.warn("[Auth] Không kết nối được máy chủ:", e);
      return { status: 'offline', message: "Không kết nối được máy chủ. Cần có mạng để đăng nhập / đổi mật khẩu." };
    }
  },

  // Lưu phiên đăng nhập do máy chủ cấp
  _startSession(user, token, remember, mustChange) {
    const now = Date.now();
    this._writeSession({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      memberId: user.memberId,
      loginAt: new Date().toISOString(),
      lastActivity: now,
      remember: !!remember,
      expiresAt: now + (remember ? this.SESSION_REMEMBER_TTL : this.SESSION_TEMP_TTL),
      token: token || null,
      mustChange: !!mustChange,
      user: user
    });
    localStorage.removeItem('SMASH_PRO_LOGGED_OUT');
    if (token) {
      const map = this._getTokens();
      map[user.username] = token;
      this._setTokens(map);
      // Thay đổi được tạo khi chưa đăng nhập (vd: dữ liệu v1 chưa gửi) -> gửi dưới tài khoản này
      let touched = false;
      this._outbox.forEach((op) => { if (!op.u) { op.u = user.username; touched = true; } });
      if (touched) LocalDB.saveOutbox(this._env, this._outbox);
    }
    this._deferredTokens = {};
    this._invalidateView();
    this._emitChanged();
    this.requestSync(0);
  },

  // Đăng nhập hệ thống (xác thực trên máy chủ)
  async login(usernameOrPhone, password, remember = false) {
    const input = (usernameOrPhone || "").trim().toLowerCase();
    const pwd = (password || "").trim();
    if (!input || !pwd) {
      return { success: false, message: "Vui lòng nhập đầy đủ tên đăng nhập/SĐT và mật khẩu!" };
    }

    if (this.isLocalOnly()) {
      const digits = input.replace(/\D/g, '');
      const user = (this._getViewObj().users || []).find(u =>
        (u.username && u.username.toLowerCase() === input) || (digits.length >= 9 && u.phone && u.phone.replace(/\D/g, '') === digits));
      if (!user || !this.verifyPassword(pwd, user.password)) {
        return { success: false, message: "Tên đăng nhập hoặc mật khẩu không chính xác, vui lòng kiểm tra lại!" };
      }
      this._startSession(user, null, remember, false);
      return { success: true, user, message: `Chào mừng ${user.name} đã đăng nhập thành công!` };
    }

    const res = await this._authRequest({ action: 'login', username: input, password: pwd });
    if (res.status !== 'ok') return { success: false, message: res.message || "Đăng nhập thất bại!" };
    this._startSession(res.user, res.token, remember, res.mustChange);
    return { success: true, user: this.getCurrentUser() || res.user, mustChange: !!res.mustChange, message: res.message };
  },

  // Đăng ký tài khoản người dùng mới (tạo trên máy chủ)
  async register({ name, phone, usernameInput, password, confirmPassword, memberType = "fixed", remember = true, note = "" }) {
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
      finalUsername = trimmedName.normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(100 + Math.random() * 900);
    }
    if (!finalUsername || finalUsername.length < 3) {
      return { success: false, message: "Tên đăng nhập hoặc số điện thoại không hợp lệ!" };
    }

    // 3. Kiểm tra trùng lặp (máy chủ kiểm tra lại)
    const exists = (data.users || []).some(u =>
      (u.username || '').toLowerCase() === finalUsername.toLowerCase() ||
      (cleanPhone && u.phone && u.phone.replace(/\D/g, '') === cleanPhone));
    if (exists) {
      return { success: false, message: `Tài khoản với tên đăng nhập hoặc SĐT "${finalUsername}" đã tồn tại trên hệ thống!` };
    }

    // 4. Kiểm tra quy tắc mật khẩu (Password Policy)
    const pwd = (password || "").trim();
    const policy = this._passwordPolicyError(pwd, confirmPassword);
    if (policy) return { success: false, message: policy };

    const avatarList = [
      "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&auto=format&fit=crop&q=80"
    ];
    const avatar = avatarList[Math.floor(Math.random() * avatarList.length)];
    const themePreference = (window.App && window.App.theme) || localStorage.getItem('smash_pro_theme') || 'light';

    if (this.isLocalOnly()) {
      const now = Date.now();
      const newUser = {
        id: "user_" + now, username: finalUsername, password: this.hashPassword(pwd), name: trimmedName,
        phone: cleanPhone || "", role: "member", memberId: "mem_" + now, type: memberType, avatar, themePreference,
        createdAt: new Date().toISOString()
      };
      data.users.push(newUser);
      data.members.push({
        id: newUser.memberId, username: finalUsername, name: trimmedName, role: "member", phone: cleanPhone || "",
        type: memberType, avatar, joinDate: new Date().toISOString().slice(0, 10), note
      });
      this.saveData(data, true);
      this._startSession(newUser, null, remember, false);
      return { success: true, user: newUser, message: `Đăng ký thành công! Tên đăng nhập của bạn là: ${finalUsername}` };
    }

    const res = await this._authRequest({
      action: 'register', name: trimmedName, phone: cleanPhone, username: finalUsername, password: pwd,
      memberType, avatar, themePreference, note
    });
    if (res.status !== 'ok') return { success: false, message: res.message || "Đăng ký thất bại!" };
    this._startSession(res.user, res.token, remember, res.mustChange);
    return { success: true, user: res.user, mustChange: !!res.mustChange, message: res.message };
  },

  // Đăng xuất khỏi hệ thống
  logout(explicit = true) {
    if (explicit) {
      localStorage.setItem('SMASH_PRO_LOGGED_OUT', 'true');
    }
    localStorage.removeItem(this._authKey());
    sessionStorage.removeItem(this._authKey());
    this._pruneTokens(); // Token chỉ còn giữ nếu tài khoản này còn thay đổi chờ gửi

    // currentUser không lưu trong CSDL (chỉ nằm trong phiên) -> chỉ cần làm mới giao diện
    try {
      this._invalidateView();
      this._emitChanged();
      this.requestSync(0); // Tải lại dữ liệu ở chế độ khách (ẩn thông tin riêng tư)
    } catch (e) {
      console.error("Lỗi xóa phiên trong CSDL:", e);
    }
  },

  // ==========================================
  // BẢO MẬT & QUẢN LÝ MẬT KHẨU TÀI KHOẢN (xử lý trên máy chủ)
  // ==========================================

  // Đổi mật khẩu của chính tài khoản đang đăng nhập
  async changePassword(userId, oldPassword, newPassword, confirmPassword) {
    const oldPwd = (oldPassword || "").trim();
    const newPwd = (newPassword || "").trim();
    if (!oldPwd) return { success: false, message: "Vui lòng nhập mật khẩu hiện tại!" };
    const policy = this._passwordPolicyError(newPwd, confirmPassword);
    if (policy) return { success: false, message: policy.replace("Mật khẩu", "Mật khẩu mới") };
    if (oldPwd === newPwd) return { success: false, message: "Mật khẩu mới không được trùng với mật khẩu cũ!" };

    const session = this._readSession();
    if (!session) return { success: false, message: "Vui lòng đăng nhập lại!" };

    if (this.isLocalOnly()) {
      const data = this.loadData();
      const user = (data.users || []).find(u => u.id === userId || u.username === userId);
      if (!user || !this.verifyPassword(oldPwd, user.password)) return { success: false, message: "Mật khẩu hiện tại không chính xác!" };
      user.password = this.hashPassword(newPwd);
      this.saveData(data, true);
      return { success: true, message: "Đổi mật khẩu thành công! Hãy ghi nhớ mật khẩu mới để đăng nhập." };
    }

    const res = await this._authRequest({ action: 'changePassword', token: session.token, oldPassword: oldPwd, newPassword: newPwd });
    if (res.status !== 'ok') return { success: false, message: res.message || "Không đổi được mật khẩu!" };
    this._startSession(res.user, res.token, session.remember, false);
    return { success: true, message: res.message };
  },

  // Lệnh email trên máy chủ (chỉ Ban quản trị): 'emailSetup' (bật/kiểm tra trình gửi) | 'emailTest' (gửi thử)
  async emailAction(action, extra = {}) {
    if (this.isLocalOnly()) return { status: 'denied', message: 'Chế độ Test không gửi email.' };
    const session = this._readSession();
    return this._authRequest(Object.assign({ action, token: session && session.token }, extra));
  },

  // Ban quản trị đặt lại mật khẩu cho thành viên
  async adminResetUserPassword(memberIdOrUserId, newPassword) {
    if (!this.isAdmin()) {
      return { success: false, message: "Chỉ Quản trị viên mới có quyền đặt lại mật khẩu cho thành viên!" };
    }
    const newPwd = (newPassword || "").trim();
    const policy = this._passwordPolicyError(newPwd);
    if (policy) return { success: false, message: policy };

    if (this.isLocalOnly()) {
      const data = this.loadData();
      const user = (data.users || []).find(u => u.memberId === memberIdOrUserId || u.id === memberIdOrUserId || u.username === memberIdOrUserId);
      if (!user) return { success: false, message: "Không tìm thấy tài khoản tương ứng với thành viên này!" };
      user.password = this.hashPassword(newPwd);
      this.saveData(data, true);
      return { success: true, message: `Đã cập nhật mật khẩu mới cho tài khoản "${user.name}" thành công!` };
    }

    const session = this._readSession();
    const res = await this._authRequest({ action: 'adminSetPassword', token: session && session.token, target: memberIdOrUserId, newPassword: newPwd });
    return { success: res.status === 'ok', message: res.message };
  },

  // Cập nhật thông tin hồ sơ cá nhân và Avatar của người dùng hiện tại
  async updateUserProfile({ userId, name, phone, email, avatar, note, bio, currentPassword, newPassword, confirmPassword }) {
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
    if (cleanPhone) {
      const duplicateUser = (data.users || []).find(u => u.id !== user.id && u.phone && u.phone.replace(/\D/g, '') === cleanPhone);
      if (duplicateUser) {
        return { success: false, message: `Số điện thoại ${phone} đã được sử dụng bởi tài khoản "${duplicateUser.name}"!` };
      }
    }

    // Đổi mật khẩu (nếu có nhập) qua máy chủ TRƯỚC, thất bại thì không lưu gì
    const wantsPassword = !!((currentPassword || "").trim() || (newPassword || "").trim() || (confirmPassword || "").trim());
    if (wantsPassword) {
      if (!(currentPassword || "").trim()) {
        return { success: false, message: "Vui lòng nhập Mật khẩu hiện tại để xác nhận thay đổi mật khẩu!" };
      }
      const pw = await this.changePassword(user.username, currentPassword, newPassword, confirmPassword);
      if (!pw.success) return pw;
    }

    // Cập nhật hồ sơ (đồng bộ dạng op, máy chủ chỉ cho sửa các trường hồ sơ của chính chủ)
    const fresh = this.loadData();
    const u = (fresh.users || []).find(x => x.id === user.id || x.username === user.username);
    if (u) {
      u.name = trimmedName;
      if (phone !== undefined) u.phone = phone.trim();
      if (email !== undefined) u.email = email.trim();
      if (avatar) u.avatar = avatar;
      if (note !== undefined || bio !== undefined) u.note = (note || bio || '').trim();
      const member = (fresh.members || []).find(m => m.id === u.memberId || (m.username && m.username === u.username));
      if (member) {
        member.name = u.name;
        member.phone = u.phone;
        if (email !== undefined) member.email = u.email;
        if (avatar) member.avatar = u.avatar;
        if (u.note !== undefined) member.note = u.note;
      }
      this.saveData(fresh, true);
    }

    return {
      success: true,
      user: this.getCurrentUser(),
      message: wantsPassword ? "Đã cập nhật hồ sơ và đổi mật khẩu mới thành công!" : "Đã cập nhật thông tin hồ sơ thành công!"
    };
  },
  // ==========================================
  // CHẾ ĐỘ DỮ LIỆU: PRODUCTION VS TEST DEMO
  // ==========================================

  // Mỗi môi trường có kho cục bộ + hàng đợi riêng; chuyển môi trường không ghi đè dữ liệu của môi trường kia
  switchDatabaseMode(mode) {
    const env = mode === 'test' ? 'CSDL_KiemThu_Test' : 'CSDL_VanHanh_Prod';
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    this.activeSheet = env;
    localStorage.setItem(ACTIVE_SHEET_KEY, env);
    this._loadEnv(env).then(() => {
      this._emitChanged();
      this._refreshBadge();
      this.requestSync(0);
    }).catch((e) => console.error('[Storage] Lỗi chuyển môi trường:', e));
    return this.loadData();
  },

  // ==========================================
  // ĐỒNG BỘ ĐÁM MÂY GOOGLE SHEETS (v2: op + delta)
  // ==========================================

  requestSync(delay = 300) {
    if (this.isLocalOnly()) return;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this.syncNow();
    }, delay);
  },

  // Gửi op đang chờ + nhận thay đổi từ máy khác. Trả về true khi không còn op chờ.
  syncNow({ full = false } = {}) {
    if (this.isLocalOnly()) {
      this._refreshBadge();
      return Promise.resolve(true);
    }
    if (full) this._syncFull = true;
    if (this._syncPromise) {
      this._syncAgain = true;
      return this._syncPromise;
    }
    this._syncPromise = this._syncLoop().finally(() => { this._syncPromise = null; });
    return this._syncPromise;
  },

  async _syncLoop() {
    if (this._ready) await this._ready.catch(() => {});
    let ok = false;
    for (let i = 0; i < 20; i++) {
      this._syncAgain = false;
      const full = this._syncFull;
      this._syncFull = false;
      const sent = this._outbox.length;
      ok = await this._syncOnce(full);
      if (!ok) break;
      // Tiếp tục khi còn op (lô lớn) hoặc có yêu cầu mới trong lúc đang đồng bộ
      if (!this._syncAgain && (!this._outbox.length || this._outbox.length >= sent)) break;
    }
    this._schedulePoll(ok);
    return ok && !this._outbox.length;
  },

  _takeBatch() {
    const batch = [];
    const tokens = this._getTokens();
    const deferred = this._deferredTokens || {};
    let size = 0;
    for (const op of this._outbox) {
      const tk = op.u ? tokens[op.u] : null;
      if (!tk || deferred[op.u] === tk) continue;
      const len = JSON.stringify(op).length;
      if (batch.length && (batch.length >= this.MAX_BATCH_OPS || size + len > this.MAX_BATCH_CHARS)) break;
      batch.push(op);
      size += len;
    }
    return batch;
  },

  async _fetchJson(url, init) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.REQUEST_TIMEOUT) : null;
    const t0 = Date.now();
    try {
      const res = await fetch(url, Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || json.status === 'error') throw new Error((json && json.message) || 'Máy chủ trả lỗi');
      // Hiệu chỉnh lệch giờ thiết bị so với máy chủ (dùng cho đồng hồ HLC)
      if (json.serverTime) {
        const rtt = Date.now() - t0;
        if (rtt < 10000) this._meta.clockOffset = json.serverTime - (t0 + rtt / 2);
        this._clock.setOffset(this._meta.clockOffset);
      }
      return json;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  async _syncOnce(full) {
    const env = this._env;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._refreshBadge('offline');
      return false;
    }
    const viewer = this.isLoggedIn() ? this._currentUsername() : '';
    const viewerChanged = viewer !== (this._meta.viewer || '');
    const since = (full || viewerChanged) ? 0 : this._meta.lastSeq;
    const batch = this._takeBatch();
    const tokens = this._getTokens();
    const auth = {};
    batch.forEach((op) => { if (op.u && tokens[op.u]) auth[op.u] = tokens[op.u]; });
    if (viewer && tokens[viewer]) auth[viewer] = tokens[viewer];
    this._refreshBadge('syncing');
    try {
      let res;
      const base = `${this.googleScriptUrl}?sheet=${encodeURIComponent(env)}`;
      if (batch.length) {
        res = await this._fetchJson(base, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ v: 2, sheet: env, deviceId: this.deviceId(), since, viewer, auth, ops: batch })
        });
      } else {
        const t = viewer && tokens[viewer] ? `&t=${encodeURIComponent(tokens[viewer])}` : '';
        res = await this._fetchJson(`${base}&v=2&since=${since}${t}`, { method: "GET" });
      }
      if (env !== this._env) return false; // Đã chuyển môi trường trong lúc chờ mạng
      if (res.status !== 'unchanged') this._meta.viewer = viewer;
      await this._applyServerResponse(res, batch, auth);
      this._failCount = 0;
      this.lastSyncedTime = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      this._refreshBadge();
      return true;
    } catch (err) {
      console.warn("[Sync] Đồng bộ thất bại, dữ liệu vẫn an toàn trên thiết bị:", err);
      this._failCount++;
      this._refreshBadge('offline');
      return false;
    }
  },

  async _applyServerResponse(res, batch, auth = {}) {
    const env = this._env;
    const changed = {};
    if (res.status !== 'unchanged') {
      if (res.full) {
        // Tải đầy đủ: thay toàn bộ bản xác nhận (op chưa gửi vẫn nằm trong outbox và được áp lại)
        this._confirmed = {};
      }
      (res.records || []).forEach((item) => {
        const rk = SyncCore.recKey(item.col, String(item.key));
        const cur = this._confirmed[rk];
        if (!cur || res.full || (Number(item.r.s) || 0) >= (cur.s || 0)) {
          this._confirmed[rk] = item.r;
          changed[rk] = item.r;
          this._clock.observe(SyncCore.recordHlcMax(item.r));
        }
      });
    }
    if (res.seq !== undefined) this._meta.lastSeq = Number(res.seq) || 0;
    // Phạm vi quyền xem đổi (vd: được nâng thành viên cố định) -> tải lại toàn bộ theo quyền mới
    if (res.scope) {
      if (!res.full && this._meta.scope && res.scope !== this._meta.scope) {
        this._syncFull = true;
        this._syncAgain = true;
      }
      this._meta.scope = res.scope;
    }

    if (batch.length && Array.isArray(res.acked)) {
      // Op bị từ chối (không đủ quyền) cũng được gỡ khỏi hàng đợi; giao diện quay về dữ liệu máy chủ
      const rejected = Array.isArray(res.rejected) ? res.rejected : [];
      const done = new Set(res.acked.concat(rejected.map((r) => r.id)));
      this._outbox = this._outbox.filter((op) => !done.has(op.id));
      LocalDB.saveOutbox(env, this._outbox);
      if (rejected.length) {
        console.warn('[Sync] Máy chủ từ chối thay đổi:', rejected);
        if (window.App) App.showToast(`⛔ ${rejected.length} thay đổi bị từ chối do tài khoản không đủ quyền.`, "error");
      }
      // Op chờ đăng nhập lại (token hết hạn / mật khẩu đã đổi / phải đổi mật khẩu yếu): ngừng gửi tới khi có token mới
      const deferredIds = new Set(Array.isArray(res.deferred) ? res.deferred : []);
      this._deferredTokens = this._deferredTokens || {};
      batch.forEach((op) => { if (deferredIds.has(op.id) && op.u) this._deferredTokens[op.u] = auth[op.u]; });
      this._pruneTokens();
    }

    const meta = { lastSeq: this._meta.lastSeq, clockOffset: this._meta.clockOffset, viewer: this._meta.viewer || '', scope: this._meta.scope || '' };
    await LocalDB.write(env, res.full
      ? { allRecords: this._confirmed, replaceAll: true, meta }
      : { records: changed, meta });

    const before = this._viewJson;
    this._rebuildWorking();
    if (before !== this._getViewJson()) {
      this._emitChanged();
      this._broadcast();
      this._applyThemeFromCloud();
    }
    this._maybeBackup();
  },

  _applyThemeFromCloud() {
    if (!window.App || typeof App.applyUserTheme !== 'function') return;
    const u = this.getCurrentUser();
    if (u && u.themePreference) App.applyUserTheme(u);
  },

  // Bản sao lưu cục bộ (trong IndexedDB, tối đa 1 lần/giờ) - thay cho 7 bản sao trong localStorage của v1
  _maybeBackup() {
    const now = Date.now();
    if (now - (this._meta.lastBackupAt || 0) < this.BACKUP_INTERVAL) return;
    this._meta.lastBackupAt = now;
    LocalDB.write(this._env, { meta: { lastBackupAt: now, backup: { at: now, json: this._getViewJson() } } })
      .catch((e) => console.warn('[Storage] Không lưu được bản sao lưu:', e));
  },

  // Kiểm tra định kỳ khi tab đang hiển thị; mất mạng -> thử lại giãn dần (2s, 4s, ... tối đa 60s)
  _schedulePoll(ok) {
    clearTimeout(this._pollTimer);
    if (this.isLocalOnly()) return;
    const delay = ok ? this.POLL_INTERVAL : Math.min(60000, 2000 * Math.pow(2, Math.max(0, this._failCount - 1)));
    this._pollTimer = setTimeout(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible' || this._outbox.length) {
        this.syncNow();
      }
    }, delay);
  },

  // Đóng/ẩn tab khi còn op chờ: gửi nhanh bằng sendBeacon (op có id, gửi trùng không gây sai lệch)
  _flushBeacon() {
    if (this.isLocalOnly() || !this._outbox.length || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
    const tokens = this._getTokens();
    const ops = this._outbox.filter((op) => op.u && tokens[op.u]).slice(0, 50);
    if (!ops.length) return;
    const auth = {};
    ops.forEach((op) => { auth[op.u] = tokens[op.u]; });
    const body = JSON.stringify({ v: 2, sheet: this._env, deviceId: this.deviceId(), since: this._meta.lastSeq, auth, ops });
    if (body.length > this.BEACON_LIMIT) return;
    try {
      navigator.sendBeacon(`${this.googleScriptUrl}?sheet=${encodeURIComponent(this._env)}`, new Blob([body], { type: 'text/plain;charset=utf-8' }));
    } catch (e) {}
  },

  pendingChangesCount() {
    return this._outbox.length;
  },

  // Tương thích nút "Lưu lên database": gửi ngay các thay đổi đang chờ
  async pushToCloud(data = null, showToast = true) {
    const ok = await this.syncNow();
    if (showToast && window.App) {
      if (ok) App.showToast(`☁️ Đã đồng bộ CSDL với database (${this._env}) thành công!`, "success");
      else App.showToast(`⚠️ Chưa kết nối được database. ${this._outbox.length} thay đổi đang chờ, sẽ tự gửi khi có mạng.`, "warning");
    }
    return ok;
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

  // Thay toàn bộ CSDL (Đặt lại / Phục hồi): op "reset" xóa mọi bản ghi cũ, sau đó tạo lại từ `data`
  _replaceAll(data) {
    const resetOp = { t: 'reset', h: this._clock.now() };
    const putOps = SyncCore.diffData({}, data, this._clock.now(), () => false);
    this._enqueue([resetOp, ...putOps], false);
  },

  // Phục hồi CSDL từ tệp JSON
  importDatabaseJSON(jsonContent) {
    try {
      const parsed = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      if (!parsed || !parsed.clubInfo) {
        throw new Error("Cấu trúc tệp sao lưu không hợp lệ!");
      }
      const restored = this.reconcileUsersAndMembers(this.sanitizeProductionData(parsed));
      this._replaceAll(restored);
      this.syncNow();
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
    this._replaceAll(JSON.parse(JSON.stringify(PROD_DEFAULT_DATA)));

    if (window.App) {
      App.refreshDashboardStats();
      App.renderUserHeaderAndSidebar();
      if (App.currentTab) App.renderTabContent(App.currentTab);
      if (showToast) App.showToast("Đang đồng bộ đặt lại CSDL sạch lên database...", "info");
    }

    const pushed = await this.syncNow();
    if (pushed && window.App && showToast) {
      App.showToast("🎉 Đã làm sạch toàn bộ CSDL và đồng bộ lên database thành công!", "success");
    }
    return this.loadData();
  },

  // Tải dữ liệu mới nhất. showToast=true (bấm tay): tải lại toàn bộ để tự sửa mọi sai lệch cục bộ.
  async pullFromCloud(showToast = true) {
    if (this.isLocalOnly()) {
      this._refreshBadge();
      return this.loadData();
    }
    const ok = await this.syncNow({ full: !!showToast });
    if (showToast && window.App) {
      if (ok) App.showToast(`☁️ Đã đồng bộ CSDL với database (${this._env})!`, "success");
      else App.showToast("⚠️ Đang chạy ở chế độ Offline với dữ liệu trên thiết bị.", "warning");
    }
    return this.loadData();
  },

  _refreshBadge(status) {
    const envLabel = (this._env || this.activeSheet) === 'CSDL_VanHanh_Prod' ? 'Prod' : 'Test';
    if (this.isLocalOnly()) {
      this.cloudSyncStatus = 'synced';
      this.updateSyncBadgeUI('synced', `Test Mode (Local Data)`);
      return;
    }
    const pending = this._outbox.length;
    if (!status) status = this._syncPromise ? 'syncing' : (this._failCount ? 'offline' : 'synced');
    this.cloudSyncStatus = status;
    if (status === 'syncing') {
      this.updateSyncBadgeUI('syncing', `Đồng bộ database (${envLabel}): Đang đồng bộ${pending ? ` ${pending} thay đổi` : ''}...`);
    } else if (status === 'offline') {
      this.updateSyncBadgeUI('offline', `Đồng bộ database (${envLabel}): Offline${pending ? ` - ${pending} thay đổi chờ gửi` : ''}`);
    } else if (pending) {
      const tokens = this._getTokens();
      const deferred = this._deferredTokens || {};
      const waiting = this._outbox.filter((op) => !op.u || !tokens[op.u] || deferred[op.u] === tokens[op.u]).length;
      this.updateSyncBadgeUI('syncing', waiting === pending
        ? `Đồng bộ database (${envLabel}): ${pending} thay đổi chờ đăng nhập lại để gửi`
        : `Đồng bộ database (${envLabel}): ${pending} thay đổi chờ gửi`);
    } else {
      this.updateSyncBadgeUI('synced', `Đồng bộ database (${envLabel}): Đã đồng bộ${this.lastSyncedTime ? ` (${this.lastSyncedTime})` : ''}`);
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
