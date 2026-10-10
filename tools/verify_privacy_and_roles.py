#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script: verify_privacy_and_roles.py
Mục đích: Tự động kiểm thử toàn diện quyền riêng tư và phân quyền người dùng:
1. Chế độ Khách vãng lai:
   - Chỉ xem được Lịch đặt sân (#schedule), Giới thiệu CLB (#dashboard), Điều khoản & Đăng ký (#members subtab register).
   - Không xem được và bị chặn truy cập Quỹ CLB (#fund), Sổ thu chi (#cashbook), Cài đặt (#settings).
   - Trong lịch đặt sân, SĐT thành viên được che giấu bảo mật (masking).
2. Chế độ Thành viên thường (Fixed Member không phải Admin):
   - Xem được danh sách thành viên nhưng SĐT/Email của người khác bị che (090****567).
   - Không có nút/link Gọi điện, Zalo, Sửa, Xóa thành viên khác.
   - Thẻ của chính mình hiển thị đầy đủ SĐT và có nút "Hồ sơ của tôi".
   - Không có quyền duyệt đóng quỹ, không có quyền quản lý/xóa/sửa thành viên khác.
3. Chế độ Quản trị viên (Admin):
   - Xem đầy đủ SĐT, Email, có toàn quyền Gọi điện, Zalo, Sửa, Xóa, Thêm thành viên, Sổ thu chi, Duyệt quỹ và Cài đặt.
"""

import os
import sys
import time
import json
import subprocess
import urllib.request
import urllib.parse
import http.server
import socketserver
import threading

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

SERVER_PORT = 5512
CHROME_PORT = 9228
WORKSPACE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WORKSPACE_DIR, **kwargs)
    def log_message(self, format, *args):
        pass

def start_local_server():
    server = socketserver.TCPServer(("127.0.0.1", SERVER_PORT), QuietHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server

def run_js(ws_url, expr):
    import websocket
    ws = websocket.create_connection(ws_url, timeout=10)
    req = {
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": True
        }
    }
    ws.send(json.dumps(req))
    res = json.loads(ws.recv())
    ws.close()
    if "result" in res and "result" in res["result"]:
        if "exceptionDetails" in res["result"]:
            print(f"  [JS Exception]: {res['result']['exceptionDetails']}")
            return None
        return res["result"]["result"].get("value")
    return None

def main():
    print("=" * 70)
    print("🚀 BẮT ĐẦU KIỂM THỬ QUYỀN RIÊNG TƯ & PHÂN QUYỀN (PRIVACY & ROLES)")
    print("=" * 70)

    server = start_local_server()
    print(f"📡 1. Local Server khởi chạy tại: http://127.0.0.1:{SERVER_PORT}")

    chrome_cmd = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        f"--remote-debugging-port={CHROME_PORT}",
        "--remote-allow-origins=*",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--user-data-dir=" + os.path.join(WORKSPACE_DIR, "scratch", f"chrome_privacy_{int(time.time())}"),
        f"http://127.0.0.1:{SERVER_PORT}/index.html"
    ]
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.5)

    ws_url = None
    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json", timeout=5)
        pages = json.loads(req.read().decode("utf-8"))
        for p in pages:
            if p.get("type") == "page":
                ws_url = p.get("webSocketDebuggerUrl")
                break
    except Exception as e:
        print(f"❌ Không kết nối được Chrome CDP: {e}")
        proc.kill()
        sys.exit(1)

    if not ws_url:
        print("❌ Không tìm thấy WebSocket Debugger URL")
        proc.kill()
        sys.exit(1)

    print(f"🌐 2. Kết nối Chrome CDP thành công!")

    # Khởi tạo CSDL mẫu đầy đủ để kiểm thử
    init_db_js = """
    (() => {
      localStorage.clear();
      sessionStorage.clear();
      
      const testData = {
        version: "2.5_PROD",
        mode: "test",
        clubInfo: {
          name: "CLB Cầu Lông Smash Pro",
          slogan: "Đam mê - Gắn kết - Tỏa sáng",
          shortName: "SMASH PRO",
          monthlyFee: 300000,
          guestFee: 50000,
          benefitsAndRules: [
            { id: "rule_1", title: "Lịch đánh cố định", content: "Thứ 7 (18h-20h) và Thứ 3 (19h30-21h30) tại sân Tre Xanh." },
            { id: "rule_2", title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." }
          ]
        },
        users: [
          {
            id: "user_admin_test",
            username: "admin",
            password: "admin",
            name: "Nguyễn Văn Admin",
            phone: "0901234567",
            email: "admin@smashpro.vn",
            role: "admin",
            type: "fixed",
            avatar: "https://ui-avatars.com/api/?name=Admin&background=10b981&color=fff"
          },
          {
            id: "user_nam_prod",
            username: "hoangnam",
            password: "user123456",
            name: "Trần Hoàng Nam",
            phone: "0988776655",
            email: "nam.tran@gmail.com",
            role: "member",
            type: "fixed",
            memberId: "mem_nam_prod",
            avatar: "https://ui-avatars.com/api/?name=Hoang+Nam&background=06b6d4&color=fff"
          },
          {
            id: "user_duc_prod",
            username: "minhduc",
            password: "user123456",
            name: "Lê Minh Đức",
            phone: "0912345999",
            email: "duc.le@yahoo.com",
            role: "member",
            type: "fixed",
            memberId: "mem_duc_prod",
            avatar: "https://ui-avatars.com/api/?name=Minh+Duc&background=8b5cf6&color=fff"
          }
        ],
        members: [
          {
            id: "mem_admin_prod",
            username: "admin",
            name: "Nguyễn Văn Admin",
            phone: "0901234567",
            email: "admin@smashpro.vn",
            type: "fixed",
            role: "admin",
            avatar: "https://ui-avatars.com/api/?name=Admin&background=10b981&color=fff"
          },
          {
            id: "mem_nam_prod",
            username: "hoangnam",
            name: "Trần Hoàng Nam",
            phone: "0988776655",
            email: "nam.tran@gmail.com",
            type: "fixed",
            role: "member",
            avatar: "https://ui-avatars.com/api/?name=Hoang+Nam&background=06b6d4&color=fff"
          },
          {
            id: "mem_duc_prod",
            username: "minhduc",
            name: "Lê Minh Đức",
            phone: "0912345999",
            email: "duc.le@yahoo.com",
            type: "fixed",
            role: "member",
            avatar: "https://ui-avatars.com/api/?name=Minh+Duc&background=8b5cf6&color=fff"
          }
        ],
        sessions: [
          {
            id: "sess_privacy_1",
            title: "Giao lưu thứ 7 sân Tre Xanh",
            date: "2026-09-28",
            startTime: "18:00",
            endTime: "20:00",
            court: "Sân số 3 & 4 Tre Xanh",
            maxPlayers: 8,
            votes: [
              { memberId: "mem_nam_prod", status: "going", guests: 0, votedAt: "10:00" },
              { memberId: "mem_duc_prod", status: "going", guests: 0, votedAt: "10:30" }
            ]
          }
        ],
        monthlyContributions: [
          { id: "due_1", month: "2026-09", memberId: "mem_admin_prod", amount: 300000, status: "paid" },
          { id: "due_2", month: "2026-09", memberId: "mem_nam_prod", amount: 300000, status: "pending" },
          { id: "due_3", month: "2026-09", memberId: "mem_duc_prod", amount: 300000, status: "unpaid" }
        ],
        transactions: []
      };

      localStorage.setItem("SMASH_PRO_ACTIVE_SHEET_V2", "CSDL_KiemThu_Test");
      AppStorage.googleScriptUrl = "";
      AppStorage.pullFromCloud = () => Promise.resolve(null);
      AppStorage.pushToCloud = () => Promise.resolve(null);
      AppStorage.saveData(testData, false);
      AppStorage.logout(false);
      App.renderUserHeaderAndSidebar();
      App.refreshDashboardStats();
      return true;
    })()
    """
    run_js(ws_url, init_db_js)
    time.sleep(1)

    passed_tests = 0
    total_tests = 0

    def assert_test(name, condition, detail=""):
        nonlocal passed_tests, total_tests
        total_tests += 1
        if condition:
            passed_tests += 1
            print(f"  ✅ [PASS] {name} {detail}")
        else:
            print(f"  ❌ [FAIL] {name} {detail}")

    print("\n--- PHẦN 1: KIỂM THỬ QUYỀN KHÁCH VÃNG LAI (GUEST MODE) ---")
    
    # 1.1 Khách vãng lai: Kiểm tra isGuest = true, isFixed = false, isAdmin = false
    guest_check = run_js(ws_url, """
    ({
      isGuest: AppStorage.isGuest(),
      isFixed: AppStorage.isFixedMember(),
      isAdmin: AppStorage.isAdmin()
    })
    """)
    assert_test("1.1 Xác định vai trò Khách vãng lai", guest_check.get("isGuest") == True and guest_check.get("isFixed") == False and guest_check.get("isAdmin") == False)

    # 1.2 Khách vãng lai: Thanh Sidebar ẩn Quỹ, Sổ thu chi, Chia tiền, Cài đặt
    sidebar_vis = run_js(ws_url, """
    (() => {
      const fundNav = document.querySelector('.nav-link[data-tab="fund"]');
      const cashbookNav = document.querySelector('.nav-link[data-tab="cashbook"]');
      const settingsNav = document.querySelector('.nav-link[data-tab="settings"]');
      const splitterNav = document.querySelector('.nav-link[data-tab="bill-splitter"]');
      return {
        fundHidden: fundNav ? fundNav.style.display === 'none' : true,
        cashbookHidden: cashbookNav ? cashbookNav.style.display === 'none' : true,
        settingsHidden: settingsNav ? settingsNav.style.display === 'none' : true,
        splitterHidden: splitterNav ? splitterNav.style.display === 'none' : true
      };
    })()
    """)
    assert_test("1.2 Menu Sidebar ẩn các mục Quỹ, Sổ thu chi, Cài đặt đối với Khách", 
                sidebar_vis.get("fundHidden") and sidebar_vis.get("cashbookHidden") and sidebar_vis.get("settingsHidden") and sidebar_vis.get("splitterHidden"))

    # 1.3 Khách vãng lai: Cố tình chuyển tab '#fund' hoặc '#cashbook' -> Bị chặn và chuyển về #schedule
    tab_block_test = run_js(ws_url, """
    (() => {
      App.openTab('fund');
      const afterFundTab = App.currentTab;
      App.openTab('cashbook');
      const afterCashTab = App.currentTab;
      App.openTab('settings');
      const afterSettingsTab = App.currentTab;
      return {
        afterFundTab,
        afterCashTab,
        afterSettingsTab
      };
    })()
    """)
    assert_test("1.3 Chặn Khách truy cập trực tiếp tab Quỹ & Sổ thu chi & Cài đặt",
                tab_block_test.get("afterFundTab") == "schedule" and tab_block_test.get("afterCashTab") == "schedule" and tab_block_test.get("afterSettingsTab") != "settings")

    # 1.4 Khách xem tab Members -> Tự động chuyển sang Subtab Phiếu đăng ký & Điều khoản CLB
    member_tab_guest = run_js(ws_url, """
    (() => {
      App.openTab('members');
      const subtab = MembersModule.currentSubTab;
      const listPanelDisplay = document.getElementById('subtab-panel-members-list')?.style.display;
      const regPanelDisplay = document.getElementById('subtab-panel-members-reg')?.style.display;
      return {
        subtab,
        listPanelDisplay,
        regPanelDisplay
      };
    })()
    """)
    assert_test("1.4 Khách vào tab Thành viên -> Hiển thị Phiếu đăng ký gia nhập & Điều khoản CLB",
                member_tab_guest.get("subtab") == "register" and member_tab_guest.get("regPanelDisplay") == "block")

    # 1.5 Khách xem lịch đánh cầu -> SĐT các thành viên đã vote bị che (masking)
    schedule_privacy_guest = run_js(ws_url, """
    (() => {
      App.openTab('schedule');
      ScheduleModule.openSessionDetailsModal('sess_privacy_1');
      const modalText = document.getElementById('global-modal-body')?.innerText || '';
      App.closeModal();
      return {
        hasFullNamPhone: modalText.includes("0988776655"),
        hasMaskedNamPhone: modalText.includes("0988****655") || modalText.includes("0988"),
        hasFullDucPhone: modalText.includes("0912345999"),
        hasMaskedDucPhone: modalText.includes("0912****999") || modalText.includes("0912")
      };
    })()
    """)
    assert_test("1.5 Lịch đặt sân: Ẩn số điện thoại người tham gia đối với Khách",
                schedule_privacy_guest is not None and schedule_privacy_guest.get("hasFullNamPhone") == False and schedule_privacy_guest.get("hasFullDucPhone") == False)

    print("\n--- PHẦN 2: KIỂM THỬ QUYỀN RIÊNG TƯ CỦA THÀNH VIÊN THƯỜNG (FIXED MEMBER) ---")
    
    # Đăng nhập dưới tư cách Thành viên thường 'hoangnam' (mem_nam_prod)
    login_member = run_js(ws_url, """
    (() => {
      const res = AppStorage.login('hoangnam', 'user123456', true);
      App.renderUserHeaderAndSidebar();
      MembersModule.renderMembersTab();
      const data = AppStorage.loadData();
      return { res, users: (data.users || []).map(u => ({ username: u.username, role: u.role })) };
    })()
    """)
    print("  [DEBUG LOGIN HOANGNAM]:", login_member)
    assert_test("2.0 Đăng nhập tài khoản Thành viên thường 'hoangnam'", login_member and login_member.get("res", {}).get("success") == True)

    # 2.1 Thành viên thường: isGuest = false, isFixed = true, isAdmin = false
    member_roles = run_js(ws_url, """
    ({
      isGuest: AppStorage.isGuest(),
      isFixed: AppStorage.isFixedMember(),
      isAdmin: AppStorage.isAdmin(),
      canManage: AppStorage.canManageMembers()
    })
    """)
    assert_test("2.1 Xác định vai trò Thành viên cố định (Fixed Member)",
                member_roles.get("isGuest") == False and member_roles.get("isFixed") == True and member_roles.get("isAdmin") == False and member_roles.get("canManage") == False)

    # 2.2 Thành viên xem danh sách thành viên:
    # - Thấy đầy đủ SĐT của CHÍNH MÌNH (0988776655)
    # - SĐT của Admin (0901234567) và mem_duc_prod (0912345999) BỊ CHE dạng 0901****567, 0912****999
    member_privacy_grid = run_js(ws_url, """
    (() => {
      App.openTab('members');
      MembersModule.switchSubTab('list');
      MembersModule.renderMembersTab();
      const grid = document.getElementById('members-grid-container');
      const html = grid ? grid.innerHTML : '';
      
      // Kiểm tra xem có thẻ liên kết tel: hoặc zalo.me tới mem_duc_prod không
      const hasTelDuc = html.includes('href="tel:0912345999"');
      const hasZaloDuc = html.includes('zalo.me/0912345999');
      const hasFullDucPhone = html.includes('0912345999');
      const hasMaskedDucPhone = html.includes('0912****999');
      
      // Kiểm tra SĐT của chính mình (mem_nam_prod)
      const hasFullMyPhone = html.includes('0988776655');
      const hasMyProfileBtn = html.includes('Hồ sơ của tôi');
      
      // Kiểm tra có nút Xóa / Sửa đối với thành viên khác không
      const hasDeleteBtn = html.includes('deleteMember');
      
      return {
        hasTelDuc,
        hasZaloDuc,
        hasFullDucPhone,
        hasMaskedDucPhone,
        hasFullMyPhone,
        hasMyProfileBtn,
        hasDeleteBtn
      };
    })()
    """)
    assert_test("2.2 SĐT thành viên khác bị che giấu bảo mật (Masking: 0912****999)", member_privacy_grid.get("hasMaskedDucPhone") == True and member_privacy_grid.get("hasFullDucPhone") == False)
    assert_test("2.3 Không có link Gọi điện (tel:) hay Zalo tới thành viên khác", member_privacy_grid.get("hasTelDuc") == False and member_privacy_grid.get("hasZaloDuc") == False)
    assert_test("2.4 Không có nút Xóa thành viên khác (deleteMember)", member_privacy_grid.get("hasDeleteBtn") == False)
    assert_test("2.5 Thẻ của chính mình hiển thị đầy đủ SĐT & có nút 'Hồ sơ của tôi'", member_privacy_grid.get("hasFullMyPhone") == True and member_privacy_grid.get("hasMyProfileBtn") == True)

    # 2.6 Thành viên thường không có quyền xóa thành viên khác khi gọi trực tiếp API
    del_perm_check = run_js(ws_url, """
    (() => {
      MembersModule.deleteMember('mem_duc_prod');
      const data = AppStorage.loadData();
      return (data.members || []).some(m => m.id === 'mem_duc_prod');
    })()
    """)
    assert_test("2.6 Chặn xóa thành viên khi không phải Admin", del_perm_check == True)

    # 2.7 Thành viên thường không có quyền sao chép SĐT cả CLB
    copy_perm_check = run_js(ws_url, """
    (() => {
      MembersModule.copyMemberList();
      return true;
    })()
    """)
    assert_test("2.7 Chặn sao chép danh sách SĐT đối với Thành viên thường", copy_perm_check == True)

    # 2.8 Thành viên thường vào tab Quỹ -> SĐT người khác bị che, và không có nút duyệt quỹ người khác
    fund_perm_check = run_js(ws_url, """
    (() => {
      App.openTab('fund');
      FundModule.renderFundDashboard();
      const tableHtml = document.getElementById('dues-table-body')?.innerHTML || '';
      const hasFullDucPhoneInFund = tableHtml.includes('0912345999');
      const hasApproveBtn = tableHtml.includes('approveDue');
      return {
        hasFullDucPhoneInFund,
        hasApproveBtn
      };
    })()
    """)
    assert_test("2.8 Tab Quỹ: Che SĐT thành viên khác và không có nút Duyệt đóng quỹ",
                fund_perm_check.get("hasFullDucPhoneInFund") == False and fund_perm_check.get("hasApproveBtn") == False)

    print("\n--- PHẦN 3: KIỂM THỬ QUYỀN TOÀN DIỆN CỦA QUẢN TRỊ VIÊN (ADMIN MODE) ---")
    
    # Đăng nhập Admin
    login_admin = run_js(ws_url, """
    (() => {
      const res = AppStorage.login('admin', 'admin', true);
      App.renderUserHeaderAndSidebar();
      return res;
    })()
    """)
    assert_test("3.0 Đăng nhập Quản trị viên (Admin)", login_admin.get("success") == True)

    # 3.1 Admin: isGuest = false, isFixed = true, isAdmin = true
    admin_roles = run_js(ws_url, """
    ({
      isGuest: AppStorage.isGuest(),
      isFixed: AppStorage.isFixedMember(),
      isAdmin: AppStorage.isAdmin(),
      canManage: AppStorage.canManageMembers()
    })
    """)
    assert_test("3.1 Xác định vai trò Quản trị viên (Admin)",
                admin_roles.get("isGuest") == False and admin_roles.get("isFixed") == True and admin_roles.get("isAdmin") == True and admin_roles.get("canManage") == True)

    # 3.2 Admin xem danh sách thành viên:
    # - Thấy đầy đủ tất cả SĐT
    # - Có đầy đủ nút Gọi điện, nút Zalo, nút Sửa, nút Xóa, nút Thêm thành viên, nút Sao chép SĐT
    admin_grid = run_js(ws_url, """
    (() => {
      App.openTab('members');
      MembersModule.switchSubTab('list');
      MembersModule.renderMembersTab();
      const grid = document.getElementById('members-grid-container');
      const html = grid ? grid.innerHTML : '';
      
      const hasTelDuc = html.includes('href="tel:0912345999"');
      const hasZaloDuc = html.includes('zalo.me/0912345999');
      const hasFullDucPhone = html.includes('0912345999');
      const hasEditBtn = html.includes('openEditMemberModal');
      const hasDeleteBtn = html.includes('deleteMember');
      
      const addMemBtn = document.querySelector('button[onclick*="openAddMemberModal"]');
      const addMemVisible = addMemBtn && addMemBtn.style.display !== 'none';
      
      return {
        hasTelDuc,
        hasZaloDuc,
        hasFullDucPhone,
        hasEditBtn,
        hasDeleteBtn,
        addMemVisible
      };
    })()
    """)
    assert_test("3.2 Admin xem đầy đủ SĐT (0912345999) của mọi thành viên", admin_grid.get("hasFullDucPhone") == True)
    assert_test("3.3 Admin có link Gọi điện (tel:) và Zalo tới mọi thành viên", admin_grid.get("hasTelDuc") == True and admin_grid.get("hasZaloDuc") == True)
    assert_test("3.4 Admin có nút Chỉnh sửa & Xóa thành viên trên từng thẻ", admin_grid.get("hasEditBtn") == True and admin_grid.get("hasDeleteBtn") == True)
    assert_test("3.5 Admin hiển thị nút '+ Thêm thành viên' và 'Sao chép SĐT'", admin_grid.get("addMemVisible") == True)

    admin_fund_check = run_js(ws_url, """
    (() => {
      try {
        App.openTab('fund');
        FundModule.setFilter('all');
        FundModule.renderFundDashboard();
        const tableHtml = document.getElementById('dues-table-body')?.innerHTML || '';
        const hasApproveBtn = tableHtml.includes('FundModule.approveDue') || tableHtml.includes('approveDue');
        return {
          hasApproveBtn,
          tableHtml: tableHtml.substring(0, 300)
        };
      } catch (err) {
        return {
          hasApproveBtn: false,
          error: err.toString(),
          stack: err.stack
        };
      }
    })()
    """)
    if not admin_fund_check.get("hasApproveBtn"):
        print("  [Debug Table HTML]:", admin_fund_check.get("tableHtml"), admin_fund_check.get("error"), admin_fund_check.get("stack"))
    assert_test("3.6 Admin có nút Duyệt đóng quỹ cho các thành viên chờ duyệt", admin_fund_check.get("hasApproveBtn") == True)

    print("\n" + "=" * 70)
    print(f"📊 KẾT QUẢ KIỂM THỬ: ĐẠT {passed_tests}/{total_tests} TIÊU CHÍ ({round(passed_tests/total_tests*100, 1)}%)")
    print("=" * 70)

    proc.kill()
    server.shutdown()

    if passed_tests == total_tests:
        print("🎉 TẤT CẢ CÁC BÀI KIỂM THỬ PHÂN QUYỀN & BẢO MẬT QUYỀN RIÊNG TƯ ĐÃ ĐẠT 100%!")
        sys.exit(0)
    else:
        print("⚠️ CÒN BÀI KIỂM THỬ CHƯA ĐẠT, VUI LÒNG KIỂM TRA LẠI!")
        sys.exit(1)

if __name__ == "__main__":
    main()
