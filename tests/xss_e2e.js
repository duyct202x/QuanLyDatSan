// Kiểm thử XSS toàn ứng dụng: nhúng mã độc vào MỌI trường dữ liệu rồi hiển thị mọi màn hình / modal / nút bấm.
// Chạy bởi tools/verify_xss.py trong index.html?test=true (chế độ cục bộ, không chạm máy chủ thật).
(async () => {
  window.__xssHits = [];
  window.__x = (id) => window.__xssHits.push(String(id) + (window.__curFn ? "@" + window.__curFn : ""));
  window.confirm = () => false;
  window.alert = () => {};
  window.prompt = () => null;
  window.open = () => null;

  let n = 0;
  const P = () => {
    n++;
    return `X${n}<img src=x onerror=__x(${n})>"'\`);__x(${n});//</textarea></script><svg onload=__x(${n})>`;
  };
  const U = () => `javascript:__x(${++n})`;
  const ID = (p) => `${p}');__x(${++n});('`;

  // Đăng nhập admin ở chế độ Test (đặt mật khẩu cục bộ)
  const d0 = AppStorage.loadData();
  d0.users.find((u) => u.username === 'admin').password = AppStorage.hashPassword('Xss-Admin-1');
  AppStorage.saveData(d0);
  await AppStorage.login('admin', 'Xss-Admin-1', true);

  const memId = ID('mem'), sesId = ID('ses'), optId = ID('opt'), txId = ID('tx');
  const data = AppStorage.loadData();
  const fee = 20000;
  data.clubInfo = Object.assign({}, data.clubInfo, {
    name: P(), shortName: P(), season: P(), description: P(), defaultCourt: P(), address: P(), bannerSubtitle: P(),
    mapUrl: U(), logo: U(), monthlyFee: fee, monthlyFundFee: fee, guestFee: 5000,
    bank: { bankId: P(), accountNo: P(), accountName: P(), qrTemplate: P() },
    benefitsAndRules: [{ id: ID('rule'), title: P(), content: P() }]
  });
  data.users.push({ id: ID('user'), username: 'evil', name: P(), phone: P(), email: P(), note: P(), avatar: U(), role: 'member', memberId: memId, type: 'fixed' });
  data.users.push({ id: ID('user2'), username: 'evil2', name: P(), phone: P(), email: P(), role: 'member', memberId: ID('m2'), type: 'guest', fixedRequest: 'pending', fixedRequestAt: P() });
  data.members.push({ id: memId, username: 'evil', name: P(), phone: P(), email: P(), note: P(), avatar: U(), role: 'member', type: 'fixed', joinDate: P(), level: P() });
  const vote = { memberId: memId, status: 'going', guests: 1, note: P(), votedAt: P(), selectedOptions: [optId] };
  const hist = { id: ID('vh'), memberId: memId, memberName: P(), avatar: U(), status: 'going', actionText: P(), note: P(), votedAt: P() };
  const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  data.sessions.unshift({
    id: sesId, title: P(), date: future, startTime: '18:00', endTime: '20:00', courtName: P(), courtNumbers: P(), courtAddress: P(),
    mapUrl: U(), courtPrice: 100000, shuttleType: P(), note: P(), status: 'open', sessionType: 'fixed', voteMode: 'standard', maxPlayers: 12,
    votes: [vote], voteHistory: [hist], timeChangeHistory: [{ note: P(), changedBy: P(), at: P() }],
    billSplit: { excluded: [], payments: {} }
  });
  data.sessions.unshift({
    id: ID('poll'), title: P(), date: future, startTime: '18:00', endTime: '20:00', courtName: P(), courtNumbers: P(), courtAddress: P(),
    mapUrl: U(), status: 'open', voteMode: 'multi_option', sessionType: 'flex',
    options: [{ id: optId, courtName: P(), courtNumbers: P(), courtAddress: P(), mapUrl: U(), date: future, startTime: '18:00', endTime: '20:00', price: 1 }],
    votes: [vote], voteHistory: [hist]
  });
  data.transactions.unshift({ id: txId, type: 'income', amount: 5000, title: P(), category: P(), date: P(), createdBy: P(), note: P(), dueId: ID('due') });
  data.monthlyContributions.push({ id: `due_2026-09_${memId}`, month: '2026-09', memberId: memId, amount: fee, status: 'pending', billImage: U(), method: P(), note: P(), paidAt: P(), approvedBy: P() });
  data.inventory = [{ id: ID('inv'), brand: P(), tubesInStock: 3, price: 1, lastRestocked: P() }];
  AppStorage.saveData(data);
  window.__payloadCount = n;

  const ids = { sessionId: sesId, memberId: memId, txId, optId, dueId: `due_2026-09_${memId}` };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errors = [];
  let clicked = 0, called = 0;

  async function clickAll() {
    const els = Array.from(document.querySelectorAll('[onclick],[onchange],[oninput]')).slice(0, 400);
    for (const el of els) {
      try {
        if (el.getAttribute('onclick')) { el.click(); clicked++; }
        else el.dispatchEvent(new Event(el.getAttribute('onchange') ? 'change' : 'input'));
      } catch (e) {}
    }
    // Ảnh lỗi (onerror) cần thời gian tải
    document.querySelectorAll('img').forEach((img) => { try { img.dispatchEvent(new Event('error')); } catch (e) {} });
    await sleep(50);
  }

  const tabs = ['dashboard', 'schedule', 'members', 'fund', 'cashbook', 'bill-splitter', 'settings'];
  for (const t of tabs) {
    try { App.openTab(t); } catch (e) { errors.push(`tab ${t}: ${e.message}`); }
    await sleep(80);
    await clickAll();
    try { App.closeModal(); } catch (e) {}
  }

  // Gọi mọi hàm open*/render*/show*/preview* của các module với id có chứa mã độc
  const modules = ['ScheduleModule', 'VoteScheduler', 'MembershipModule', 'VotingModule', 'MembersModule', 'FundModule', 'CashbookModule', 'BillSplitterModule', 'SettingsModule', 'InventoryModule', 'MatchmakerModule', 'App'];
  for (const name of modules) {
    const mod = window[name];
    if (!mod) continue;
    for (const fn of Object.keys(mod)) {
      if (typeof mod[fn] !== 'function' || !/^(open|render|show|preview|view)/i.test(fn) || /^(openTab|showAuthModal|openModal)$/.test(fn)) continue;
      for (const arg of [ids.sessionId, ids.memberId, ids.txId, ids.dueId]) {
        window.__curFn = name + "." + fn;
        try { const r = mod[fn](arg, P(), ids.optId); if (r && r.then) await r.catch(() => {}); called++; } catch (e) {}
        await sleep(5);
        await clickAll();
        try { App.closeModal(); } catch (e) {}
      }
    }
  }
  window.__curFn = "App.showToast";
  try { App.showToast(P(), "info"); } catch (e) {}
  await sleep(300);

  window.__xssResult = {
    payloads: window.__payloadCount, hits: window.__xssHits, clicked, called, errors: errors.slice(0, 10),
    // Dữ liệu vẫn hiển thị đúng dạng chữ (không vỡ giao diện): tên CLB có chữ "X" + phần mã độc dạng văn bản
    textVisible: document.body.innerText.includes('<img src=x onerror=__x(')
  };
})();
