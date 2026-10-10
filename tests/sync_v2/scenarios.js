// Kịch bản kiểm thử đồng bộ & bảo mật đa thiết bị v2 (chạy bằng: python tools/verify_sync_v2.py)
const results = [];
const out = document.getElementById('out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = { admin: 'Admin@Club2026', an: 'An-Pass-2026', binh: '123456' };
const URL_P = 'https://x/exec?sheet=CSDL_VanHanh_Prod';
let nsSeq = 0;

function baseV1() {
  return {
    clubInfo: { name: 'CLB Thật', monthlyFee: 20000, benefitsAndRules: [{ id: 'r1', title: 'Luật', content: 'x' }] },
    clubInfoUpdatedAt: 1000,
    users: [
      { id: 'user_admin', username: 'admin', password: AuthCore.canonical(PW.admin), name: 'Admin Thật', role: 'admin', memberId: 'mem_admin', type: 'fixed', phone: '0988776655', themePreference: 'light', updatedAt: 1000 },
      { id: 'user_an', username: 'an', password: AuthCore.canonical(PW.an), name: 'An', role: 'member', memberId: 'mem_an', type: 'fixed', phone: '0911000111', themePreference: 'light', updatedAt: 1000 },
      // Mật khẩu kiểu cũ lưu dạng thô và quá yếu
      { id: 'user_binh', username: 'binh', password: PW.binh, name: 'Bình', role: 'member', memberId: 'mem_binh', type: 'fixed', phone: '0922000222', themePreference: 'light', updatedAt: 1000 }
    ],
    members: [
      { id: 'mem_admin', username: 'admin', name: 'Admin Thật', role: 'admin', type: 'fixed', phone: '0988776655', updatedAt: 1000 },
      { id: 'mem_an', username: 'an', name: 'An', role: 'member', type: 'fixed', phone: '0911000111', updatedAt: 1000 },
      { id: 'mem_binh', username: 'binh', name: 'Bình', role: 'member', type: 'fixed', phone: '0922000222', updatedAt: 1000 }
    ],
    sessions: [{ id: 's1', title: 'Buổi 1', date: '2026-10-20', note: '', votes: [], voteHistory: [], updatedAt: 1000 }],
    transactions: [{ id: 'tx1', type: 'income', amount: 100, title: 'Thu', date: '2026-10-01', updatedAt: 1000 }],
    monthlyContributions: [
      { id: 'due_2026-10_mem_admin', month: '2026-10', memberId: 'mem_admin', amount: 20000, status: 'paid', billImage: 'data:image/jpeg;base64,ADMINBILL', updatedAt: 1000 }
    ],
    inventory: [],
    tombstones: {},
    lastModified: 1000
  };
}

function seed(data) {
  FakeGAS.reset();
  FakeGAS.seedV1('CSDL_VanHanh_Prod', data || baseV1());
}

async function device(name, { offline = false, skew = 0, ns = null, init = true, login = null } = {}) {
  const f = document.createElement('iframe');
  ns = ns || `${name}_${++nsSeq}`;
  f.src = `client.html?ns=${encodeURIComponent(ns)}`;
  document.body.appendChild(f);
  await new Promise((r) => { f.onload = r; });
  const w = f.contentWindow;
  w.__frame = f;
  w.__ns = ns;
  w.__offline = offline;
  w.__skew = skew;
  if (init) {
    await w.AppStorage.init();
    if (login) {
      const r = await w.AppStorage.login(login, PW[login], true);
      if (!r.success) throw new Error('Đăng nhập thất bại: ' + login + ' - ' + r.message);
    }
    await settle(w);
  }
  return w;
}

function kill(w) {
  w.__frame.remove();
}

async function reload(w, opts = {}) {
  const ns = w.__ns;
  kill(w);
  return device('', Object.assign({ ns }, opts));
}

// Đồng bộ tới khi không còn request đang chạy (hoặc đang offline / chỉ còn op chờ đăng nhập)
async function settle(w) {
  for (let i = 0; i < 6; i++) {
    await w.AppStorage.syncNow();
    if (!w.AppStorage._syncPromise && (!w.AppStorage._takeBatch().length || w.__offline)) return;
    await sleep(5);
  }
}

function edit(w, fn) {
  const d = w.AppStorage.loadData();
  fn(d);
  w.AppStorage.saveData(d);
}

const user = (w, un) => w.AppStorage.loadData().users.find((u) => u.username === un);
const member = (w, id) => w.AppStorage.loadData().members.find((m) => m.id === id);
const session = (w, id) => w.AppStorage.loadData().sessions.find((s) => s.id === id);
const tx = (w, id) => w.AppStorage.loadData().transactions.find((t) => t.id === id);
const post = async (body) => (await fakeServerFetch(URL_P, { method: 'POST', body: JSON.stringify(body) })).json();
const get = async (qs) => (await fakeServerFetch(`${URL_P}${qs || ''}`, { method: 'GET' })).json();
const serverLogin = async (u, p) => post({ v: 2, action: 'login', username: u, password: p });
// Đọc bản ghi thật trên "sheet" (không lọc) để kiểm tra kết quả phía máy chủ
function serverRecord(col, key) {
  const sheet = FakeGAS.sheet('CSDL_VanHanh_Prod_v2');
  for (const row of sheet._cells.slice(1)) {
    if (row && row[0] === col && row[1] === key) return SyncCore.decode(col, JSON.parse(row.slice(3).filter((c) => c !== '' && c !== undefined).join('')).d);
  }
  return null;
}
function sheetText() {
  return JSON.stringify(FakeGAS.sheet('CSDL_VanHanh_Prod_v2')._cells);
}

function check(name, cond, detail) {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' :: ' + JSON.stringify(detail)}`);
}

const scenarios = {
  // ===================== BẢO MẬT =====================
  async noPasswordFallbacks() {
    seed();
    const attempts = [['admin', 'admin'], ['admin', 'admin123'], ['admin', '0988776655'], ['an', '0911000111'], ['an', 'password123'], ['admin', '']];
    const res = [];
    for (const [u, p] of attempts) res.push((await serverLogin(u, p)).status);
    const ok = await serverLogin('admin', PW.admin);
    check('bảo mật: admin/admin, admin123, SĐT, password123... đều bị từ chối', res.every((s) => s === 'denied'), res);
    check('bảo mật: mật khẩu đúng đăng nhập được, không trả về mật khẩu', ok.status === 'ok' && !!ok.token && ok.user && !('password' in ok.user) && !('pwv' in ok.user), ok);
    const A = await device('A');
    const r = await A.AppStorage.login('admin', 'admin', true);
    check('bảo mật: giao diện đăng nhập admin/admin thất bại', !r.success && !A.AppStorage.getCurrentUser(), r);
    kill(A);
  },

  async passwordsNeverLeaveServer() {
    seed();
    const guest = await get('&v=2&since=0');
    const v1 = await get('');
    const admin = await serverLogin('admin', PW.admin);
    const asAdmin = await get(`&v=2&since=0&t=${encodeURIComponent(admin.token)}`);
    const all = JSON.stringify([guest, v1, asAdmin]);
    check('bảo mật: không phản hồi nào chứa mật khẩu/hash (v2 khách, v1, v2 admin)',
      !/password|\$kdf1|\$sha256|pwv/.test(all), all.match(/.{30}(password|\$kdf1|\$sha256|pwv).{30}/));
    const guestPhones = /0911000111|0988776655|ADMINBILL/.test(JSON.stringify(guest)) || /0911000111|ADMINBILL/.test(JSON.stringify(v1));
    check('bảo mật: khách không xem được SĐT / ảnh biên lai của thành viên', !guestPhones, null);
    check('bảo mật: Ban quản trị vẫn xem được SĐT', /0911000111/.test(JSON.stringify(asAdmin)), null);
    check('bảo mật: mật khẩu cũ (thô/sha256 không muối) đã được bọc $kdf1$ trên máy chủ',
      !/"123456"|\$sha256\$/.test(sheetText()) && /\$kdf1\$/.test(sheetText()), null);
    const binh = await serverLogin('binh', PW.binh);
    check('bảo mật: mật khẩu cũ vẫn đăng nhập được sau khi bọc (nhưng bị buộc đổi vì yếu)', binh.status === 'ok' && binh.mustChange === true, binh.status);
  },

  async bruteForceLock() {
    seed();
    const res = [];
    for (let i = 0; i < 5; i++) res.push((await serverLogin('admin', 'sai-' + i)).status);
    const locked = await serverLogin('admin', PW.admin);
    check('bảo mật: khóa đăng nhập 15 phút sau 5 lần sai (kể cả khi sau đó nhập đúng)', res.every((s) => s === 'denied') && locked.status === 'denied', { res, locked: locked.status });
  },

  async forgedAndUnauthorizedWrites() {
    seed();
    await get('&v=2&since=0'); // chạy chuyển dữ liệu
    const op = (o) => Object.assign({ id: 'x' + Math.random(), t: 'patch', h: SyncCore.hlcPack(Date.now() + 1000, 0, 'evil') }, o);
    const anTok = (await serverLogin('an', PW.an)).token;
    const fakeTok = AuthCore.signToken({ u: 'admin', pv: 1, exp: Date.now() + 1e7 }, 'doan-bi-mat');
    const r1 = await post({ v: 2, ops: [op({ col: 'users', key: 'an', u: 'an', set: { role: 'admin' } })] });
    const r2 = await post({ v: 2, auth: { admin: fakeTok }, ops: [op({ col: 'users', key: 'admin', u: 'admin', set: { password: 'hacked' } })] });
    const r3 = await post({ v: 2, auth: { an: anTok }, ops: [
      op({ col: 'users', key: 'an', u: 'an', set: { role: 'admin' } }),
      op({ col: 'members', key: 'mem_admin', u: 'an', set: { name: 'Bị sửa' } }),
      op({ col: 'transactions', key: 'tx_evil', u: 'an', t: 'put', set: { id: 'tx_evil', type: 'expense', amount: 999, title: 'Rút quỹ' } }),
      op({ col: 'transactions', key: 'tx1', u: 'an', t: 'del' }),
      op({ col: 'users', key: 'an', u: 'an', set: { password: '$sha256$' + 'f'.repeat(64) } }),
      op({ col: 'club', key: 'info', u: 'an', set: { name: 'CLB bị chiếm' } }),
      { id: 'reset1', t: 'reset', u: 'an', h: SyncCore.hlcPack(Date.now() + 2000, 0, 'evil') }
    ] });
    const r4 = await post({ v: 2, auth: { an: anTok }, ops: [
      op({ col: 'users', key: 'an', u: 'an', set: { name: 'An Mới', themePreference: 'dark' } }),
      op({ col: 'sessions', key: 's1', u: 'an', set: { 'votes#mem_an': { memberId: 'mem_an', status: 'going' }, 'votes#': ['mem_an'] } }),
      op({ col: 'sessions', key: 's1', u: 'an', set: { 'votes#mem_admin': { memberId: 'mem_admin', status: 'not_going' } } })
    ] });
    const an = serverRecord('users', 'an');
    check('bảo mật: op không token / token giả bị hoãn, không được áp dụng',
      r1.deferred.length === 1 && r2.deferred.length === 1 && serverRecord('users', 'an').role === 'member' && AuthCore.verify(serverRecord('users', 'admin').password, PW.admin).ok, { r1: r1.deferred, r2: r2.deferred });
    check('bảo mật: thành viên không tự nâng quyền, không sửa người khác/sổ quỹ/CLB/mật khẩu, không xóa hết dữ liệu',
      r3.rejected.length === 7 && r3.acked.length === 0 && an.role === 'member' && serverRecord('members', 'mem_admin').name === 'Admin Thật' && !serverRecord('transactions', 'tx_evil') && !!serverRecord('transactions', 'tx1') && serverRecord('club', 'info').name === 'CLB Thật',
      { rejected: r3.rejected.length, acked: r3.acked.length });
    check('bảo mật: thành viên vẫn sửa được hồ sơ của mình và bình chọn cho chính mình (không bình chọn hộ)',
      r4.acked.length === 2 && r4.rejected.length === 1 && an.name === 'An Mới' && serverRecord('sessions', 's1').votes.length === 1,
      { acked: r4.acked.length, rejected: r4.rejected, votes: serverRecord('sessions', 's1').votes });
    const v1 = await post(Object.assign(baseV1(), { clubInfo: { name: 'Ghi đè v1' } }));
    check('bảo mật: máy chạy mã cũ (v1, không xác thực) không ghi được', v1.status === 'error' && v1.code === 'outdated' && serverRecord('club', 'info').name === 'CLB Thật', v1.status);
  },

  async weakPasswordMustChange() {
    seed();
    const B = await device('B');
    const r = await B.AppStorage.login('binh', PW.binh, true);
    await settle(B);
    edit(B, (d) => { d.users.find((u) => u.username === 'binh').themePreference = 'dark'; });
    await settle(B);
    const pendingWhileWeak = B.AppStorage.pendingChangesCount();
    const bad = await B.AppStorage.changePassword('binh', PW.binh, '0922000222', '0922000222');
    const good = await B.AppStorage.changePassword('binh', PW.binh, 'Binh#Moi-2026', 'Binh#Moi-2026');
    await settle(B);
    check('bảo mật: mật khẩu yếu -> bắt buộc đổi; thay đổi bị giữ lại tới khi đổi xong rồi mới gửi',
      r.success && r.mustChange && pendingWhileWeak === 1 && !bad.success && good.success && B.AppStorage.pendingChangesCount() === 0 && serverRecord('users', 'binh').themePreference === 'dark',
      { r, pendingWhileWeak, bad: bad.message, good: good.message, after: B.AppStorage.pendingChangesCount() });
    kill(B);
  },

  async passwordChangeRevokesOtherDevices() {
    seed();
    const A = await device('A', { login: 'an' });
    const B = await device('B', { login: 'an' });
    const res = await A.AppStorage.changePassword('an', PW.an, 'An-Moi#2026', 'An-Moi#2026');
    edit(B, (d) => { d.users.find((u) => u.username === 'an').note = 'từ máy B'; });
    await settle(B);
    const heldOnB = B.AppStorage.pendingChangesCount();
    const noteBefore = serverRecord('users', 'an').note;
    await B.AppStorage.login('an', 'An-Moi#2026', true);
    await settle(B);
    check('bảo mật: đổi mật khẩu vô hiệu hóa phiên trên thiết bị khác; thay đổi của thiết bị đó được giữ và gửi sau khi đăng nhập lại',
      res.success && heldOnB === 1 && noteBefore !== 'từ máy B' && serverRecord('users', 'an').note === 'từ máy B',
      { res: res.message, heldOnB, noteBefore, after: serverRecord('users', 'an').note });
    kill(A); kill(B);
  },

  async adminSetsMemberPassword() {
    seed();
    const A = await device('A', { login: 'admin' });
    edit(A, (d) => { d.users.find((u) => u.username === 'an').password = A.AppStorage.hashPassword('Do-Admin-Dat1'); });
    await settle(A);
    const okNew = await serverLogin('an', 'Do-Admin-Dat1');
    const okOld = await serverLogin('an', PW.an);
    check('bảo mật: Ban quản trị đặt mật khẩu thành viên (qua dữ liệu) -> máy chủ băm lại, mật khẩu cũ hết hiệu lực',
      okNew.status === 'ok' && okOld.status === 'denied' && AuthCore.isKdf(serverRecord('users', 'an').password) && !('password' in (user(A, 'an') || {})),
      { okNew: okNew.status, okOld: okOld.status });
    const res = await A.AppStorage.adminResetUserPassword('mem_binh', 'Tam-Thoi-99');
    check('bảo mật: Ban quản trị đặt lại mật khẩu thành viên qua máy chủ', res.success && (await serverLogin('binh', 'Tam-Thoi-99')).status === 'ok', res);
    kill(A);
  },

  async registerViaServer() {
    seed();
    const G = await device('G');
    const r = await G.AppStorage.register({ name: 'Cường', phone: '0933444555', usernameInput: '', password: 'Cuong-2026!', confirmPassword: 'Cuong-2026!', memberType: 'fixed' });
    await settle(G);
    const dup = await post({ v: 2, action: 'register', name: 'Giả mạo', username: 'admin', phone: '', password: 'Abcdef-123' });
    check('bảo mật: đăng ký tạo tài khoản trên máy chủ (vai trò member, mật khẩu băm), không chiếm được tên đăng nhập đã có',
      r.success && serverRecord('users', '0933444555').role === 'member' && AuthCore.isKdf(serverRecord('users', '0933444555').password) &&
      G.AppStorage.getCurrentUser().username === '0933444555' && dup.status === 'denied' && serverRecord('users', 'admin').name === 'Admin Thật',
      { r: r.message, dup: dup.status });
    kill(G);
  },

  async guestSeesScheduleOnly() {
    const data = baseV1();
    data.sessions[0].votes = [{ memberId: 'mem_an', status: 'going', guests: 0, note: 'An đi muộn', votedAt: '2026-10-10 10:00' }];
    data.sessions[0].voteHistory = [{ id: 'vh_1', memberId: 'mem_an', memberName: 'An', status: 'going', actionText: 'Đăng ký', votedAt: '2026-10-10 10:00' }];
    data.sessions[0].billSplit = { excluded: [], payments: { mem_an: { paid: true, amount: 50000 } } };
    data.users.push({ id: 'user_khach', username: 'khach', password: AuthCore.canonical('Khach-Pass-26'), name: 'Khách Vãng Lai', role: 'member', memberId: 'mem_khach', type: 'guest', updatedAt: 1000 });
    data.members.push({ id: 'mem_khach', username: 'khach', name: 'Khách Vãng Lai', role: 'member', type: 'guest', updatedAt: 1000 });
    seed(data);
    const guest = await get('&v=2&since=0');
    const g = JSON.stringify(guest);
    const cols = (res) => [...new Set(res.records.map((r) => r.col))].sort().join(',');
    const sess = guest.records.find((r) => r.col === 'sessions').r.d;
    check('khách: xem được lịch đánh (buổi + số người tham gia)', sess.title === 'Buổi 1' && sess['votes#mem_an'] && sess['votes#mem_an'].status === 'going', sess);
    check('khách: không nhận tên thành viên, tài khoản, sổ thu chi, quỹ tháng, chia tiền, ghi chú vote',
      !/"An"|Admin Thật|Bình|Khách Vãng Lai|An đi muộn|50000/.test(g) && !/"col":"(users|transactions|monthlyContributions)"/.test(g) && !('voteHistory#vh_1' in sess) && !('billSplit' in sess),
      { cols: cols(guest), leak: (g.match(/.{20}("An"|Admin Thật|Bình|An đi muộn|50000).{20}/) || [])[0] });
    const v1 = JSON.stringify(await get(''));
    check('khách (API v1 cũ): cũng không lộ tên thành viên / sổ thu chi', !/Admin Thật|Bình|"Thu"|An đi muộn/.test(v1), (v1.match(/.{20}(Admin Thật|Bình|"Thu"|An đi muộn).{20}/) || [])[0]);
    const kt = (await serverLogin('khach', 'Khach-Pass-26')).token;
    const asGuestAcc = await get(`&v=2&since=0&t=${encodeURIComponent(kt)}`);
    const at = (await serverLogin('an', PW.an)).token;
    const asFixed = await get(`&v=2&since=0&t=${encodeURIComponent(at)}`);
    check('tài khoản vãng lai: thấy tên thành viên nhưng không thấy sổ thu chi/quỹ', /Admin Thật/.test(JSON.stringify(asGuestAcc)) && !/"col":"(transactions|monthlyContributions)"/.test(JSON.stringify(asGuestAcc)), cols(asGuestAcc));
    check('thành viên cố định: thấy sổ thu chi & quỹ tháng', /"col":"transactions"/.test(JSON.stringify(asFixed)) && /"col":"monthlyContributions"/.test(JSON.stringify(asFixed)), cols(asFixed));
    const A = await device('A');
    const guestView = A.AppStorage.loadData();
    check('khách: giao diện không có dữ liệu sổ thu chi / tên thật', guestView.transactions.length === 0 && !JSON.stringify(guestView.members).includes('Bình'), { tx: guestView.transactions.length });
    await A.AppStorage.login('admin', PW.admin, true);
    await settle(A);
    const adminView = A.AppStorage.loadData();
    check('đăng nhập Ban quản trị: tự tải lại đầy đủ dữ liệu theo quyền mới', adminView.transactions.length === 1 && !!adminView.members.find((m) => m.name === 'Bình'), { tx: adminView.transactions.length });
    A.AppStorage.logout(true);
    await settle(A);
    check('đăng xuất: dữ liệu riêng tư bị xóa khỏi thiết bị', A.AppStorage.loadData().transactions.length === 0 && !JSON.stringify(A.AppStorage.loadData().members).includes('Bình'), A.AppStorage.loadData().transactions.length);
    kill(A);
  },

  async memberInputValidation() {
    const data = baseV1();
    data.sessions.push({ id: 's_old', title: 'Buổi đã qua', date: '2026-01-01', startTime: '18:00', votes: [], voteHistory: [], updatedAt: 1000 });
    seed(data);
    const at = (await serverLogin('an', PW.an)).token;
    const op = (o) => Object.assign({ id: 'v' + Math.random(), t: 'patch', u: 'an', h: SyncCore.hlcPack(Date.now(), 0, 'an') }, o);
    const r = await post({ v: 2, auth: { an: at }, ops: [
      op({ col: 'users', key: 'an', set: { avatar: 'javascript:alert(1)' } }),
      op({ col: 'users', key: 'an', set: { name: 'x'.repeat(5000) } }),
      op({ col: 'sessions', key: 's1', set: { 'votes#mem_an': { memberId: 'mem_an', status: '<img src=x onerror=alert(1)>' } } }),
      op({ col: 'sessions', key: 's1', set: { 'votes#mem_an': { memberId: 'mem_an', status: 'going', role: 'admin' } } }),
      op({ col: 'sessions', key: 's_old', set: { 'votes#mem_an': { memberId: 'mem_an', status: 'going' } } }),
      op({ col: 'monthlyContributions', key: 'due_x', t: 'put', set: { id: 'due_x', month: '2026-10', memberId: 'mem_an', amount: 20000, status: 'pending' } }),
      op({ col: 'sessions', key: 's1', set: { 'voteHistory#vh_9': { id: 'vh_9', memberId: 'mem_an', memberName: 'Admin Thật', status: 'going', actionText: 'Đăng ký' } } })
    ] });
    const reasons = r.rejected.map((x) => x.reason);
    check('kiểm tra dữ liệu: chặn URL javascript:, chuỗi quá dài, giá trị lạ, trường thừa, khóa sai định dạng',
      reasons.filter((x) => x === 'invalid').length === 5 && serverRecord('users', 'an').name === 'An', reasons);
    check('khóa bình chọn: không vote được buổi đã quá hạn (kiểm tra trên máy chủ)', reasons.indexOf('vote_locked') !== -1 && !serverRecord('sessions', 's_old').votes.length, reasons);
    const hist = serverRecord('sessions', 's1').voteHistory.find((h) => h.id === 'vh_9');
    check('chống mạo danh: tên trong lịch sử bình chọn lấy từ hồ sơ trên máy chủ', hist && hist.memberName === 'An', hist);
    let denied = 0;
    for (let i = 0; i < 31; i++) {
      const res = await post({ v: 2, action: 'register', name: 'Spam ' + i, username: 'spam' + i, password: 'Spam-Pass-' + i });
      if (res.status === 'denied') denied++;
    }
    check('chống spam: tối đa 30 lượt đăng ký mỗi giờ', denied === 1, denied);
  },

  // ===================== HẸN GIỜ MỞ VOTE & THÔNG BÁO =====================
  async scheduledVoteOpenAndNotices() {
    const data = baseV1();
    data.users[0].email = 'admin@clb.vn';
    data.users[1].email = 'an@clb.vn';
    data.users[2].email = 'binh@clb.vn';
    data.clubInfo.emailNotify = { enabled: true };
    seed(data);
    window.__mails = [];
    const A = await device('A', { login: 'admin' });
    const B = await device('B', { login: 'an' });
    const vs = (w) => w.VoteScheduler;
    const future = (ms) => vs(A).toLocalInput(Date.now() + ms);
    // Admin hẹn giờ mở vote sau 2 giờ
    edit(A, (d) => { d.sessions.find((s) => s.id === 's1').voteOpenAt = future(2 * 3600e3); });
    await settle(A); await settle(B);
    edit(B, (d) => { d.sessions.find((s) => s.id === 's1').votes.push({ memberId: 'mem_an', status: 'going', guests: 0 }); });
    await settle(B);
    check('hẹn giờ: thành viên chưa vote được trước giờ mở (máy chủ từ chối, giao diện quay lại)',
      !serverRecord('sessions', 's1').votes.length && !session(B, 's1').votes.length && vs(B).getOpenState(session(B, 's1')).isOpen === false,
      { server: serverRecord('sessions', 's1').votes, client: session(B, 's1').votes });
    const userB = B.AppStorage.getCurrentUser();
    check('hẹn giờ: chưa tới giờ thì chưa có thông báo mở vote', vs(B).collectNew(B.AppStorage.loadData(), userB).length === 0, null);
    // Tới giờ: thiết bị B tự phát hiện (kiểm tra tại thời điểm sau giờ mở)
    const later = Date.now() + 2 * 3600e3 + 60e3;
    const opened = vs(B).collectNew(B.AppStorage.loadData(), userB, later);
    const again = vs(B).collectNew(B.AppStorage.loadData(), userB, later);
    check('hẹn giờ: tới giờ mở -> thành viên nhận thông báo mở bình chọn (chỉ 1 lần)', opened.length === 1 && opened[0].type === 'vote_open' && again.length === 0, opened.map((x) => x.type));
    // Admin mở vote ngay -> B vote được
    edit(A, (d) => {
      const s = d.sessions.find((x) => x.id === 's1');
      s.voteOpenAt = '';
      vs(A).addNotice(s, 'vote_open');
    });
    await settle(A); await settle(B);
    edit(B, (d) => { d.sessions.find((s) => s.id === 's1').votes.push({ memberId: 'mem_an', status: 'going', guests: 0 }); });
    await settle(B);
    check('mở vote ngay: thành viên vote được', serverRecord('sessions', 's1').votes.length === 1, serverRecord('sessions', 's1').votes);
    guiThongBaoTuDong(); // Trình gửi email chạy định kỳ (10 phút/lần)
    // Admin đặt sân -> thông báo cho người đã vote tham gia (An), không gửi cho người không vote (Bình)
    await settle(A);
    edit(A, (d) => {
      const s = d.sessions.find((x) => x.id === 's1');
      s.status = 'booked';
      vs(A).addNotice(s, 'booked');
    });
    await settle(A); await settle(B);
    const C = await device('C', { login: 'binh' });
    const forAn = vs(B).collectNew(B.AppStorage.loadData(), B.AppStorage.getCurrentUser()).map((x) => x.type);
    const forBinh = vs(C).collectNew(C.AppStorage.loadData(), C.AppStorage.getCurrentUser()).map((x) => x.type);
    const forAdmin = vs(A).collectNew(A.AppStorage.loadData(), A.AppStorage.getCurrentUser()).map((x) => x.type);
    check('đặt sân: người đã vote tham gia nhận thông báo; người không vote và người thao tác thì không',
      forAn.includes('booked') && !forBinh.includes('booked') && !forAdmin.includes('booked'), { forAn, forBinh, forAdmin });
    edit(A, (d) => {
      const s = d.sessions.find((x) => x.id === 's1');
      s.status = 'cancelled';
      vs(A).addNotice(s, 'cancelled');
    });
    await settle(A); await settle(B);
    const cancelAn = vs(B).collectNew(B.AppStorage.loadData(), B.AppStorage.getCurrentUser()).map((x) => x.type);
    check('hủy sân: người đã vote tham gia nhận thông báo hủy', cancelAn.includes('cancelled'), cancelAn);
    const guestSess = (await get('&v=2&since=0')).records.find((r) => r.col === 'sessions').r.d;
    check('khách: không nhận dữ liệu thông báo nội bộ (danh sách người nhận)', !Object.keys(guestSess).some((p) => p.indexOf('notices') === 0), Object.keys(guestSess));
    // Email: chạy trình kích hoạt 2 lần
    guiThongBaoTuDong();
    const first = window.__mails.slice();
    guiThongBaoTuDong();
    guiThongBaoTuDong();
    const toOf = (type) => first.filter((m) => m.subject.includes(type)).map((m) => m.to).sort();
    check('email: mở vote -> mọi thành viên có email; đặt/hủy sân -> chỉ người đã vote tham gia',
      JSON.stringify(toOf('Đã mở bình chọn')) === JSON.stringify(['admin@clb.vn', 'an@clb.vn', 'binh@clb.vn']) &&
      JSON.stringify(toOf('Đã đặt sân')) === JSON.stringify(['an@clb.vn']) && JSON.stringify(toOf('Đã hủy buổi')) === JSON.stringify(['an@clb.vn']),
      first.map((m) => [m.to, m.subject]));
    check('email: mỗi thông báo chỉ gửi 1 lần', window.__mails.length === first.length, { first: first.length, total: window.__mails.length });
    kill(A); kill(B); kill(C);
  },

  async emailPreferences() {
    const data = baseV1();
    data.users[0].email = 'admin@clb.vn';
    data.users[1].email = 'an@clb.vn';
    data.users[2].email = 'binh@clb.vn';
    const soon = new Date(Date.now() + 3 * 3600e3 + 7 * 3600e3).toISOString(); // giờ VN
    data.sessions[0].votes = [{ memberId: 'mem_an', status: 'going', guests: 0 }];
    data.sessions[0].date = soon.slice(0, 10);
    data.sessions[0].startTime = soon.slice(11, 16);
    data.sessions[0].status = 'booked';
    data.sessions.push({ id: 's_quiet', title: 'Buổi không email', date: soon.slice(0, 10), startTime: soon.slice(11, 16), status: 'booked',
      emailNotify: false, votes: [{ memberId: 'mem_an', status: 'going' }], voteHistory: [], updatedAt: 1000 });
    data.clubInfo.emailNotify = { enabled: false, reminder: true, reminderHours: 4 };
    seed(data);
    window.__mails = [];
    const A = await device('A', { login: 'admin' });
    guiThongBaoTuDong();
    const whenOff = window.__mails.length;
    edit(A, (d) => { d.clubInfo.emailNotify = { enabled: true, voteOpen: false, booked: false, cancelled: true, reminder: true, reminderHours: 4 }; });
    await settle(A);
    edit(A, (d) => {
      const s = d.sessions.find((x) => x.id === 's1');
      A.VoteScheduler.addNotice(s, 'booked'); // tắt email đặt sân -> không gửi
      const q = d.sessions.find((x) => x.id === 's_quiet');
      q.status = 'cancelled';
      A.VoteScheduler.addNotice(q, 'cancelled'); // buổi tắt email -> không gửi
    });
    await settle(A);
    guiThongBaoTuDong();
    const subjects = window.__mails.map((m) => m.to + '|' + m.subject);
    check('email: Ban quản trị tắt -> không gửi gì', whenOff === 0, whenOff);
    check('email: chỉ gửi sự kiện được chọn (nhắc lịch bật, đặt sân tắt) và bỏ qua buổi tắt email',
      subjects.length === 1 && /an@clb\.vn\|.*Nhắc lịch: Buổi 1/.test(subjects[0]), subjects);
    // Lệnh từ ứng dụng: bật trình gửi & gửi thử (chỉ Ban quản trị)
    const setup = await A.AppStorage.emailAction('emailSetup', { enable: true });
    const test = await A.AppStorage.emailAction('emailTest', {});
    const B = await device('B', { login: 'an' });
    const denied = await B.AppStorage.emailAction('emailSetup', { enable: true });
    check('email: Ban quản trị bật trình gửi và gửi thử từ ứng dụng; thành viên thường bị từ chối',
      setup.status === 'ok' && setup.installed && window.__triggers.length === 1 && test.status === 'ok' &&
      window.__mails.some((m) => m.to === 'admin@clb.vn' && /Email thử/.test(m.subject)) && denied.status === 'denied',
      { setup, test: test.status, denied: denied.status, triggers: window.__triggers.length });
    kill(A); kill(B);
  },

  async fixedMemberApproval() {
    const data = baseV1();
    data.users[0].email = 'admin@clb.vn';
    data.clubInfo.emailNotify = { enabled: true };
    seed(data);
    window.__mails = [];
    const G = await device('G');
    const r = await G.AppStorage.register({ name: 'Dũng', phone: '0944555666', password: 'Dung-Pass-26', confirmPassword: 'Dung-Pass-26', memberType: 'fixed' });
    await settle(G);
    const u = serverRecord('users', '0944555666');
    check('đăng ký cố định -> tạo tài khoản vãng lai, yêu cầu chờ duyệt (chưa xem được sổ quỹ)',
      r.success && u.type === 'guest' && u.fixedRequest === 'pending' && G.AppStorage.loadData().transactions.length === 0 && /chờ Ban quản trị duyệt/.test(r.message),
      { type: u.type, req: u.fixedRequest, tx: G.AppStorage.loadData().transactions.length });
    const tok = (await serverLogin('0944555666', 'Dung-Pass-26')).token;
    const op = (o) => Object.assign({ id: 'f' + Math.random(), t: 'patch', u: '0944555666', h: SyncCore.hlcPack(Date.now() + 1000, 0, 'x') }, o);
    const self = await post({ v: 2, auth: { '0944555666': tok }, ops: [
      op({ col: 'users', key: '0944555666', set: { type: 'fixed' } }),
      op({ col: 'users', key: '0944555666', set: { fixedRequest: 'approved' } }),
      op({ col: 'members', key: u.memberId, set: { type: 'fixed' } })
    ] });
    check('thành viên không tự duyệt / tự đổi thành cố định', self.rejected.length === 3 && serverRecord('users', '0944555666').type === 'guest', self.rejected);
    const A = await device('A', { login: 'admin' });
    const adminSees = A.MembershipModule.collectNew(A.AppStorage.loadData(), A.AppStorage.getCurrentUser()).map((x) => x.type);
    check('Ban quản trị thấy yêu cầu chờ duyệt và nhận thông báo', A.MembershipModule.pendingUsers(A.AppStorage.loadData()).length === 1 && adminSees.includes('request'), adminSees);
    guiThongBaoTuDong();
    check('email: yêu cầu thành viên cố định gửi tới Ban quản trị', window.__mails.some((m) => m.to === 'admin@clb.vn' && /Yêu cầu thành viên cố định: Dũng/.test(m.subject)), window.__mails.map((m) => m.subject));
    await A.MembershipModule.decide('0944555666', true);
    await settle(A);
    await settle(G); await settle(G);
    const gu = G.AppStorage.getCurrentUser();
    const note = G.MembershipModule.collectNew(G.AppStorage.loadData(), gu).map((x) => x.type);
    check('duyệt: thành viên thành cố định, tự tải lại quyền (thấy sổ quỹ) và nhận thông báo',
      serverRecord('users', '0944555666').type === 'fixed' && serverRecord('members', u.memberId).type === 'fixed' &&
      gu.type === 'fixed' && G.AppStorage.loadData().transactions.length === 1 && note.includes('approved'),
      { type: gu.type, tx: G.AppStorage.loadData().transactions.length, note });
    kill(A); kill(G);
  },

  // ===================== KHÔI PHỤC KHI CHUYỂN DỮ LIỆU v1 -> v2 THẤT BẠI =====================
  async migrationRecovery() {
    const countSessions = async () => (await get('&v=2&since=0')).records.filter((r) => r.col === 'sessions').length;
    // 1) Cờ "đã chuyển" đã được đặt nhưng kho v2 trống (lần chuyển trước không nhập được gì)
    FakeGAS.reset();
    FakeGAS.seedV1('CSDL_VanHanh_Prod', baseV1());
    FakeGAS.setProp('v2migrated:CSDL_VanHanh_Prod', 1);
    FakeGAS.setProp('v2auth:CSDL_VanHanh_Prod', 1);
    const a = await countSessions();
    // 2) Sheet v1 bị đổi tên
    FakeGAS.reset();
    FakeGAS.seedV1('CSDL_VanHanh_Prod (sao lưu)', baseV1());
    const b = await countSessions();
    // 3) D2 ghi sai số mảnh JSON (dữ liệu thực tế 3 mảnh, D2 = 1)
    FakeGAS.reset();
    FakeGAS.seedV1('CSDL_VanHanh_Prod', baseV1(), { chunks: 3, chunkCountCell: 1 });
    const c = await countSessions();
    const login = await serverLogin('admin', PW.admin);
    check('khôi phục: kho v2 trống dù đã đánh dấu chuyển -> tự nhập lại dữ liệu v1', a === 1, a);
    check('khôi phục: tìm được sheet v1 đã đổi tên (theo tiêu đề DATA_JSON)', b === 1, b);
    check('khôi phục: đọc đúng dữ liệu v1 dù ô D2 ghi sai số mảnh', c === 1 && login.status === 'ok', { c, login: login.status });
    // 4) Không nhập nhầm sheet Test vào Prod, không nhập đè khi v2 đã có dữ liệu
    FakeGAS.reset();
    FakeGAS.seedV1('CSDL_KiemThu_Test', Object.assign(baseV1(), { clubInfo: { name: 'CLB TEST' } }));
    const d = (await get('&v=2&since=0')).records.length;
    check('khôi phục: không lấy nhầm dữ liệu sheet Test cho Prod', d === 0, d);
    // 5) Hàm chẩn đoán chỉ đọc, chạy được và báo đúng tình trạng
    FakeGAS.reset();
    FakeGAS.seedV1('CSDL_VanHanh_Prod', baseV1());
    const report = kiemTraDuLieu();
    check('chẩn đoán: báo có dữ liệu v1 và kho v2 chưa có, không ghi gì', report.v1 && report.v1.counts.sessions === 1 && report.v2.rows === 0 && !FakeGAS.sheet('CSDL_VanHanh_Prod_v2'),
      report);
  },

  // ===================== ĐỒNG BỘ =====================
  async migrationFromV1() {
    seed();
    const A = await device('A', { login: 'admin' });
    const d = A.AppStorage.loadData();
    check('migration: dữ liệu v1 được chuyển sang v2 đầy đủ',
      d.clubInfo.name === 'CLB Thật' && user(A, 'an') && session(A, 's1') && tx(A, 'tx1') && tx(A, 'tx1').amount === 100,
      { club: d.clubInfo.name, users: d.users.map((u) => u.username) });
    check('migration: sheet v1 cũ được giữ nguyên làm bản sao lưu', !!FakeGAS.sheet('CSDL_VanHanh_Prod') && !!FakeGAS.sheet('CSDL_VanHanh_Prod_v2'), null);
    kill(A);
  },

  async staleDeviceDoesNotRevertOtherFields() {
    seed();
    const A = await device('A', { login: 'an' });
    const B = await device('B', { login: 'an' });
    A.__offline = true;
    edit(B, (d) => { d.users.find((u) => u.username === 'an').name = 'An (B sửa)'; });
    await settle(B);
    await sleep(5);
    edit(A, (d) => { d.users.find((u) => u.username === 'an').themePreference = 'dark'; });
    A.__offline = false;
    await settle(A);
    await settle(B);
    const ua = user(A, 'an'), ub = user(B, 'an');
    check('máy cũ đổi theme KHÔNG làm mất thay đổi hồ sơ mới của máy khác',
      ua.name === 'An (B sửa)' && ub.name === 'An (B sửa)' && ua.themePreference === 'dark' && ub.themePreference === 'dark',
      { a: [ua.name, ua.themePreference], b: [ub.name, ub.themePreference] });
    kill(A); kill(B);
  },

  async concurrentVotesBothKept() {
    seed();
    const A = await device('A', { login: 'an' });
    const B = await device('B', { login: 'admin' });
    A.__offline = true; B.__offline = true;
    edit(A, (d) => { d.sessions.find((s) => s.id === 's1').votes.push({ memberId: 'mem_an', status: 'going', guests: 0, votedAt: '2026-10-10 10:00' }); });
    edit(B, (d) => { d.sessions.find((s) => s.id === 's1').votes.push({ memberId: 'mem_admin', status: 'going', guests: 1, votedAt: '2026-10-10 10:00' }); });
    A.__offline = false; B.__offline = false;
    await settle(A); await settle(B); await settle(A);
    const va = session(A, 's1').votes.map((v) => v.memberId).sort();
    const vb = session(B, 's1').votes.map((v) => v.memberId).sort();
    check('2 người bình chọn cùng lúc (offline) -> giữ cả 2 phiếu', va.length === 2 && vb.length === 2, { va, vb });
    kill(A); kill(B);
  },

  async offlineQueueSurvivesReload() {
    seed();
    let A = await device('A', { login: 'admin' });
    const B = await device('B', { login: 'admin' });
    A.__offline = true;
    edit(A, (d) => {
      d.transactions.unshift({ id: 'tx2', type: 'expense', amount: 50, title: 'Mua cầu', date: '2026-10-10' });
      d.users.find((u) => u.username === 'an').name = 'An Nguyễn';
      d.sessions = d.sessions.filter((s) => s.id !== 's1');
    });
    const pendingBefore = A.AppStorage.pendingChangesCount();
    A = await reload(A, { offline: true });
    check('offline: thay đổi còn nguyên sau khi tải lại trang (chưa có mạng)',
      !!tx(A, 'tx2') && !session(A, 's1') && user(A, 'an').name === 'An Nguyễn' && A.AppStorage.pendingChangesCount() === pendingBefore,
      { pendingBefore, after: A.AppStorage.pendingChangesCount() });
    A.__offline = false;
    await settle(A);
    await settle(B);
    check('offline: có mạng trở lại -> máy khác nhận đủ thay đổi',
      !!tx(B, 'tx2') && !session(B, 's1') && user(B, 'an').name === 'An Nguyễn' && A.AppStorage.pendingChangesCount() === 0,
      { tx2: !!tx(B, 'tx2'), s1: !!session(B, 's1'), pending: A.AppStorage.pendingChangesCount() });
    check('giao dịch mới hiển thị đầu danh sách (giữ thứ tự mới nhất trước)', B.AppStorage.loadData().transactions[0].id === 'tx2', B.AppStorage.loadData().transactions.map((t) => t.id));
    kill(A); kill(B);
  },

  async clockSkewDeviceStillWins() {
    seed();
    const A = await device('A', { skew: -3600 * 1000, login: 'admin' }); // Đồng hồ máy A chậm 1 giờ
    const B = await device('B', { login: 'admin' });
    edit(B, (d) => { d.transactions.find((t) => t.id === 'tx1').amount = 200; });
    await settle(B);
    await settle(A);
    edit(A, (d) => { d.transactions.find((t) => t.id === 'tx1').amount = 300; });
    await settle(A);
    await settle(B);
    check('máy lệch giờ (chậm 1h) sửa SAU khi đã thấy bản mới -> vẫn được ghi nhận', tx(A, 'tx1').amount === 300 && tx(B, 'tx1').amount === 300,
      { a: tx(A, 'tx1').amount, b: tx(B, 'tx1').amount });
    kill(A); kill(B);
  },

  async deleteNewerThanEditWins() {
    seed();
    const A = await device('A', { login: 'admin' });
    const B = await device('B', { login: 'admin' });
    A.__offline = true;
    edit(B, (d) => { d.sessions.find((s) => s.id === 's1').note = 'B sửa'; });
    await settle(B);
    await sleep(5);
    edit(A, (d) => { d.sessions = d.sessions.filter((s) => s.id !== 's1'); });
    A.__offline = false;
    await settle(A); await settle(B);
    check('xóa (mới hơn) thắng sửa (cũ hơn): bản ghi không sống lại', !session(A, 's1') && !session(B, 's1'), null);
    kill(A); kill(B);
  },

  async resetDoesNotReviveStaleData() {
    seed();
    const A = await device('A', { login: 'admin' });
    const B = await device('B', { login: 'admin' });
    B.__offline = true;
    await A.AppStorage.resetData(false);
    await settle(A);
    B.__offline = false;
    await settle(B);
    const d = B.AppStorage.loadData();
    check('đặt lại CSDL: máy cũ không làm sống lại dữ liệu cũ',
      !session(B, 's1') && !user(B, 'an') && !tx(B, 'tx1') && d.clubInfo.name === B.eval('PROD_DEFAULT_DATA').clubInfo.name,
      { s1: !!session(B, 's1'), an: !!user(B, 'an'), club: d.clubInfo.name });
    kill(A); kill(B);
  },

  async legacyPendingLocalChangesMergedPerField() {
    const server = baseV1();
    server.transactions[0].title = 'Thu (máy chủ)';
    server.transactions[0].updatedAt = 5000;
    seed(server);
    const local = baseV1();
    local.transactions[0].title = 'Thu (máy cũ)';
    local.transactions[0].updatedAt = 2000;      // Bản cũ hơn -> phải thua
    local.sessions[0].note = 'ghi chú offline';
    local.sessions[0].updatedAt = 9000;          // Sửa sau -> phải thắng
    local.users[0].password = AuthCore.canonical('admin'); // Dữ liệu cũ mang mật khẩu yếu -> KHÔNG được đè
    local.users[0].updatedAt = 9000;
    local.transactions.unshift({ id: 'tx3', type: 'income', amount: 30, title: 'Thu offline', date: '2026-10-09', updatedAt: 9000 });
    localStorage.setItem('SMASH_PRO_BADMINTON_APP_V2', JSON.stringify(local));
    localStorage.setItem('SMASH_PRO_PENDING_PUSH_CSDL_VanHanh_Prod', '1');
    const C = await device('C');
    await settle(C);
    const heldBeforeLogin = C.AppStorage.pendingChangesCount();
    await C.AppStorage.login('admin', PW.admin, true);
    await settle(C);
    const D = await device('D', { login: 'admin' });
    check('nâng cấp từ v1: thay đổi chưa gửi chờ đăng nhập, rồi hợp nhất theo trường (cũ thua, mới thắng)',
      heldBeforeLogin === 1 && tx(D, 'tx1').title === 'Thu (máy chủ)' && session(D, 's1').note === 'ghi chú offline' && !!tx(D, 'tx3'),
      { heldBeforeLogin, tx1: tx(D, 'tx1').title, note: session(D, 's1').note, tx3: !!tx(D, 'tx3') });
    check('nâng cấp từ v1: dữ liệu cũ không ghi đè được mật khẩu', (await serverLogin('admin', 'admin')).status === 'denied' && (await serverLogin('admin', PW.admin)).status === 'ok', null);
    check('nâng cấp từ v1: giải phóng các bản sao CSDL cũ trong localStorage',
      localStorage.getItem('SMASH_PRO_BADMINTON_APP_V2') === null && localStorage.getItem('SMASH_PRO_PENDING_PUSH_CSDL_VanHanh_Prod') === null, null);
    kill(C); kill(D);
  },

  async newDeviceSkeletonNeverOverwrites() {
    seed();
    const E = await device('E', { offline: true }); // Thiết bị mới, chưa từng đồng bộ
    E.__offline = false;
    await E.AppStorage.login('admin', PW.admin, true); // Đăng nhập xong mất mạng ngay, chưa kịp tải dữ liệu
    E.__offline = true;
    edit(E, (d) => { d.users.find((u) => u.username === 'admin').themePreference = 'dark'; });
    E.__offline = false;
    await settle(E);
    const F = await device('F', { login: 'admin' });
    const admin = user(F, 'admin');
    check('thiết bị mới (dữ liệu mặc định) không ghi đè dữ liệu thật trên máy chủ',
      admin.name === 'Admin Thật' && admin.themePreference === 'dark' && F.AppStorage.loadData().clubInfo.name === 'CLB Thật' && !!user(F, 'an'),
      { name: admin.name, theme: admin.themePreference, club: F.AppStorage.loadData().clubInfo.name });
    kill(E); kill(F);
  },

  async massDeleteGuard() {
    const data = baseV1();
    for (let i = 0; i < 12; i++) data.transactions.push({ id: 'm' + i, type: 'income', amount: 10, title: 'T' + i, date: '2026-10-01', updatedAt: 1000 });
    seed(data);
    const A = await device('A', { login: 'admin' });
    edit(A, (d) => { d.transactions = []; });
    await settle(A);
    check('chặn xóa hàng loạt bất thường trong 1 lần lưu', A.AppStorage.loadData().transactions.length === 13, A.AppStorage.loadData().transactions.length);
    kill(A);
  },

  async deltaAndIdempotency() {
    seed();
    const A = await device('A', { login: 'admin' });
    const seqBefore = A.AppStorage._meta.lastSeq;
    let captured = null;
    const orig = window.fakeServerFetch;
    window.fakeServerFetch = (url, init) => {
      if (init && init.method === 'POST') captured = { url, init: { method: 'POST', body: init.body } };
      return orig(url, init).then((res) => res.json().then((j) => {
        window.__lastResp = j;
        return { ok: true, status: 200, json: () => Promise.resolve(j) };
      }));
    };
    edit(A, (d) => { d.transactions.find((t) => t.id === 'tx1').title = 'Thu quỹ'; });
    await settle(A);
    window.fakeServerFetch = orig;
    check('delta: một thay đổi nhỏ chỉ trả về 1 bản ghi', window.__lastResp.records.length === 1, window.__lastResp.records.length);
    const seqAfter = A.AppStorage._meta.lastSeq;
    const replay = await (await orig(captured.url, captured.init)).json();
    check('gửi lặp lại cùng op (mạng chập chờn) không tạo thay đổi mới', replay.seq === seqAfter && seqAfter === seqBefore + 1, { seqBefore, seqAfter, replay: replay.seq });
    const unchanged = await get(`&v=2&since=${seqAfter}`);
    check('kiểm tra định kỳ khi không có gì mới -> "unchanged" (không đọc dữ liệu)', unchanged.status === 'unchanged', unchanged.status);
    kill(A);
  },

  async memberPaymentFlow() {
    seed();
    const A = await device('A', { login: 'an' });
    edit(A, (d) => {
      const due = d.monthlyContributions.find((x) => x.memberId === 'mem_an');
      due.status = 'pending'; due.billImage = 'data:image/jpeg;base64,ANBILL'; due.method = 'Chuyển khoản VietQR'; due.paidAt = '2026-10-10 10:00';
    });
    await settle(A);
    const due = A.AppStorage.loadData().monthlyContributions.find((x) => x.memberId === 'mem_an');
    const B = await device('B', { login: 'binh' });
    const binhSees = JSON.stringify(B.AppStorage.loadData().monthlyContributions);
    const Adm = await device('Adm', { login: 'admin' });
    const adminSees = JSON.stringify(Adm.AppStorage.loadData().monthlyContributions);
    check('thành viên gửi xác nhận đóng quỹ (chờ duyệt) được máy chủ chấp nhận', due && due.status === 'pending' && A.AppStorage.pendingChangesCount() === 0, due);
    check('bảo mật: ảnh biên lai chỉ chủ nhân & Ban quản trị xem được', !binhSees.includes('ANBILL') && adminSees.includes('ANBILL'), null);
    kill(A); kill(B); kill(Adm);
  }
};

(async () => {
  for (const [name, fn] of Object.entries(scenarios)) {
    try {
      await fn();
    } catch (e) {
      results.push(`FAIL ${name} :: EXCEPTION ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
    }
    document.querySelectorAll('iframe').forEach((f) => f.remove());
  }
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  out.textContent = results.join('\n') + `\nDONE ${passed}/${results.length}`;
  document.title = 'DONE';
})();
