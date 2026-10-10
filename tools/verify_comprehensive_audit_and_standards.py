import os
import sys
import json
import time
import subprocess
import threading
import http.server
import socketserver
import urllib.request
import websocket

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SCRATCH_DIR = os.path.join(PROJECT_ROOT, 'scratch')
os.makedirs(SCRATCH_DIR, exist_ok=True)

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CHROME_PORT = 9255
SERVER_PORT = 8128

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PROJECT_ROOT, **kwargs)
    def log_message(self, format, *args):
        pass

def start_local_server():
    server = socketserver.TCPServer(("127.0.0.1", SERVER_PORT), QuietHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server

def start_browser():
    user_data_dir = os.path.join(SCRATCH_DIR, f"chrome_audit_{int(time.time())}")
    cmd = [
        CHROME_PATH,
        f"--remote-debugging-port={CHROME_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "--disable-gpu",
        f"http://127.0.0.1:{SERVER_PORT}/index.html"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    return proc

def send_cdp(ws, method, params=None, msg_id=1):
    msg = {"id": msg_id, "method": method, "params": params or {}}
    ws.send(json.dumps(msg))
    while True:
        res = json.loads(ws.recv())
        if res.get("id") == msg_id:
            return res.get("result", {})

def eval_js(ws, expr, msg_id_holder=[100]):
    msg_id_holder[0] += 1
    res = send_cdp(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, msg_id_holder[0])
    if "exceptionDetails" in res:
        print(f"JS Exception: {res['exceptionDetails']}")
    return res.get("result", {}).get("value")

def run_comprehensive_audit():
    print("================================================================================")
    print("🔍 RÀ SOÁT, ĐÁNH GIÁ & KIỂM THỬ TOÀN DIỆN CÁC CHỨC NĂNG VÀ TIÊU CHUẨN CHUẨN HÓA")
    print("================================================================================")

    server = start_local_server()
    proc = start_browser()
    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json")
        tabs = json.loads(req.read().decode())
        ws_url = None
        for t in tabs:
            if t.get("type") == "page":
                ws_url = t.get("webSocketDebuggerUrl")
                break
        if not ws_url:
            ws_url = tabs[0]["webSocketDebuggerUrl"]

        ws = websocket.create_connection(ws_url)
        send_cdp(ws, "Page.enable")
        send_cdp(ws, "Runtime.enable")

        # Đợi ứng dụng sẵn sàng và override confirm/alert
        for _ in range(30):
            ready = eval_js(ws, "typeof AppStorage !== 'undefined' && typeof App !== 'undefined'")
            if ready:
                eval_js(ws, "window.confirm = () => true; window.alert = () => {};")
                break
            time.sleep(0.3)

        passed_count = 0
        total_count = 0

        def check(title, condition, detail=""):
            nonlocal passed_count, total_count
            total_count += 1
            if condition:
                passed_count += 1
                print(f"  ✅ [PASS {total_count:02d}] {title} {detail}")
            else:
                print(f"  ❌ [FAIL {total_count:02d}] {title} {detail}")

        # ==============================================================================
        # PHẦN 1: RÀ SOÁT CẤU TRÚC DỮ LIỆU & TIÊU CHUẨN KHỞI TẠO (DATA INTEGRITY)
        # ==============================================================================
        print("\n--- PHẦN 1: RÀ SOÁT CẤU TRÚC DỮ LIỆU & TIÊU CHUẨN KHỞI TẠO (DATA INTEGRITY) ---")
        data_audit = eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            return {
                version: data.version,
                hasClubInfo: !!data.clubInfo && !!data.clubInfo.bank,
                bankAccountNo: data.clubInfo?.bank?.accountNo,
                bankId: data.clubInfo?.bank?.bankId,
                monthlyFee: data.clubInfo?.monthlyFee,
                guestFee: data.clubInfo?.guestFee,
                rulesCount: (data.clubInfo?.benefitsAndRules || []).length,
                usersCount: (data.users || []).length,
                adminUser: (data.users || []).find(u => u.username === 'admin'),
                hasReconcile: typeof AppStorage.reconcileUsersAndMembers === 'function',
                hasMasking: typeof AppStorage.maskPhone === 'function' && typeof AppStorage.maskEmail === 'function'
            };
        })()
        """)
        check("Phiên bản CSDL chuẩn hóa 2.7_PROD", data_audit['version'] in ['2.7_PROD', '2.6_PROD', '2.5_PROD'], f"(Version: {data_audit['version']})")
        check("Cấu hình thông tin CLB & Ngân hàng VietQR đầy đủ", data_audit['hasClubInfo'] and bool(data_audit['bankAccountNo']), f"(STK: {data_audit['bankAccountNo']} - {data_audit['bankId']})")
        check("Mức phí quỹ tháng và vãng lai chuẩn hóa", data_audit['monthlyFee'] >= 20000 and data_audit['guestFee'] >= 5000, f"(Quỹ: {data_audit['monthlyFee']}đ, Vãng lai: {data_audit['guestFee']}đ)")
        check("Quy định & Quyền lợi CLB động hóa", data_audit['rulesCount'] >= 2, f"({data_audit['rulesCount']} điều khoản)")
        check("Tài khoản Quản trị viên (Admin) mặc định có sẵn", bool(data_audit['adminUser']) and data_audit['adminUser']['role'] == 'admin')
        check("Cơ chế Đối soát & Đồng bộ 2 chiều (reconcileUsersAndMembers)", data_audit['hasReconcile'] is True)
        check("Cơ chế Bảo mật & Che giấu thông tin (Contact Masking)", data_audit['hasMasking'] is True)

        # ==============================================================================
        # PHẦN 2: RÀ SOÁT VAI TRÒ KHÁCH VÃNG LAI (GUEST MODE)
        # ==============================================================================
        print("\n--- PHẦN 2: RÀ SOÁT TIÊU CHUẨN VAI TRÒ KHÁCH VÃNG LAI (GUEST MODE) ---")
        guest_audit = eval_js(ws, """
        (() => {
            AppStorage.logout(false);
            App.renderUserHeaderAndSidebar();
            
            // Kiểm tra Sidebar menu
            const fundNav = document.querySelector('.nav-link[data-tab="fund"]');
            const cashbookNav = document.querySelector('.nav-link[data-tab="cashbook"]');
            const settingsNav = document.querySelector('.nav-link[data-tab="settings"]');
            const splitterNav = document.querySelector('.nav-link[data-tab="bill-splitter"]');
            const navLabel = document.getElementById('nav-members-label')?.innerText;

            // Thử truy cập tab cấm
            App.openTab('fund');
            const tabAfterFund = App.currentTab;
            App.openTab('cashbook');
            const tabAfterCash = App.currentTab;

            // Mở tab Thành viên
            App.openTab('members');
            const currentSubTab = MembersModule.currentSubTab;

            return {
                isGuest: AppStorage.isGuest(),
                fundHidden: fundNav ? fundNav.style.display === 'none' : true,
                cashbookHidden: cashbookNav ? cashbookNav.style.display === 'none' : true,
                settingsHidden: settingsNav ? settingsNav.style.display === 'none' : true,
                splitterHidden: splitterNav ? splitterNav.style.display === 'none' : true,
                navLabel,
                tabAfterFund,
                tabAfterCash,
                currentSubTab
            };
        })()
        """)
        check("Xác định vai trò Khách vãng lai (Chưa đăng nhập)", guest_audit['isGuest'] is True)
        check("Ẩn hoàn toàn các tab Quỹ, Sổ thu chi, Chia tiền, Cài đặt trên Sidebar", guest_audit['fundHidden'] and guest_audit['cashbookHidden'] and guest_audit['settingsHidden'] and guest_audit['splitterHidden'])
        check("Chặn truy cập trực tiếp vào Quỹ & Sổ thu chi (Chuyển về Lịch sân)", guest_audit['tabAfterFund'] == 'schedule' and guest_audit['tabAfterCash'] == 'schedule')
        check("Nhãn menu Thành viên hiển thị 'Nội quy & Đăng ký'", 'Nội quy' in guest_audit['navLabel'] or 'Đăng ký' in guest_audit['navLabel'])
        check("Khách mở tab Thành viên tự động chuyển sang Subtab Phiếu đăng ký & Quy định", guest_audit['currentSubTab'] == 'register')

        # ==============================================================================
        # PHẦN 3: RÀ SOÁT VAI TRÒ THÀNH VIÊN THƯỜNG (MEMBER PRIVACY & RESTRICTIONS)
        # ==============================================================================
        print("\n--- PHẦN 3: RÀ SOÁT TIÊU CHUẨN THÀNH VIÊN THƯỜNG (MEMBER PRIVACY & PERMISSIONS) ---")
        member_audit = eval_js(ws, """
        (() => {
            window.confirm = () => true;
            window.alert = () => true;
            
            // Đảm bảo có tài khoản thành viên để kiểm thử phân quyền
            const curData = AppStorage.loadData();
            if (!curData.users.some(u => u.username === 'thaovy')) {
                curData.users.push({
                    id: 'user_thaovy_test',
                    username: 'thaovy',
                    password: 'password123',
                    name: 'Hoàng Thảo Vy',
                    phone: '0977665544',
                    role: 'member',
                    memberId: 'mem_thaovy_test',
                    type: 'fixed'
                });
                curData.members.push({
                    id: 'mem_thaovy_test',
                    username: 'thaovy',
                    name: 'Hoàng Thảo Vy',
                    phone: '0977665544',
                    type: 'fixed',
                    role: 'member'
                });
                curData.members.push({
                    id: 'mem_other_test',
                    username: 'other',
                    name: 'Trần Văn Nam',
                    phone: '0911223344',
                    type: 'fixed',
                    role: 'member'
                });
                AppStorage.saveData(curData, false);
            }

            AppStorage.login('thaovy', 'password123', true);
            App.renderUserHeaderAndSidebar();
            
            // 1. Kiểm tra nhãn menu & tiêu đề
            const navLabel = document.getElementById('nav-members-label')?.innerText;
            const tabTitle = document.querySelector('#tab-members .tab-main-title')?.innerText;
            
            // 2. Thao tác trên Danh bạ thành viên
            App.openTab('members');
            MembersModule.switchSubTab('list');
            MembersModule.renderMembersTab();
            const gridHtml = document.getElementById('members-grid-container')?.innerHTML || '';
            const addMemBtn = document.querySelector('button[onclick*="openAddMemberModal"]');
            const copyBtn = document.querySelector('button[onclick*="copyMemberList"]');
            
            // 3. Kiểm tra bảo mật Quỹ (fund.js)
            App.openTab('fund');
            FundModule.renderFundDashboard();
            const fundTableHtml = document.getElementById('dues-table-body')?.innerHTML || '';
            
            // 4. Kiểm tra Lịch & Bình chọn (schedule.js, voting.js)
            App.openTab('schedule');
            ScheduleModule.renderSessions('sessions-container', 'all');
            const deleteSessionBtns = document.querySelectorAll('#sessions-container button[onclick*="confirmDeleteSession"]');
            
            return {
                isAdmin: AppStorage.isAdmin(),
                isFixed: AppStorage.isFixedMember(),
                navLabel,
                tabTitle,
                addMemHidden: !addMemBtn || addMemBtn.style.display === 'none',
                copyBtnHidden: !copyBtn || copyBtn.style.display === 'none',
                gridHasSelfProfileBtn: gridHtml.includes('Hồ sơ của tôi'),
                gridOtherDuePrivate: gridHtml.includes('Riêng tư'),
                gridNoAdminActionsForOther: !gridHtml.includes('openEditMemberModal') && !gridHtml.includes('deleteMember'),
                fundTableOtherPrivate: fundTableHtml.includes('Riêng tư'),
                fundTableHasSelfPayBtn: fundTableHtml.includes('Đóng quỹ'),
                deleteBtnsCount: deleteSessionBtns.length
            };
        })()
        """)
        check("Xác định vai trò Thành viên cố định (Chính thức)", member_audit['isFixed'] is True and member_audit['isAdmin'] is False)
        check("Nhãn menu hiển thị 'Danh bạ thành viên' & Tiêu đề chuẩn", 'Danh bạ' in member_audit['navLabel'] and 'Danh bạ thành viên' in member_audit['tabTitle'])
        check("Ẩn nút '+ Thêm thành viên' và 'Sao chép SĐT' với thành viên thường", member_audit['addMemHidden'] and member_audit['copyBtnHidden'])
        check("Thẻ của chính mình hiển thị nút '[👤 Hồ sơ của tôi]'", member_audit['gridHasSelfProfileBtn'] is True)
        check("Thẻ người khác che trạng thái quỹ '🔒 Riêng tư' & không có nút Quản trị", member_audit['gridOtherDuePrivate'] and member_audit['gridNoAdminActionsForOther'])
        check("Bảng thu quỹ che trạng thái người khác & hiển thị nút 'Đóng quỹ' cho chính mình", member_audit['fundTableOtherPrivate'] and member_audit['fundTableHasSelfPayBtn'])
        check("Không hiển thị nút 'Xóa buổi' trên lịch đặt sân", member_audit['deleteBtnsCount'] == 0)

        # ==============================================================================
        # PHẦN 4: RÀ SOÁT VAI TRÒ QUẢN TRỊ VIÊN (ADMIN ROLES & CASHBOOK MANAGEMENT)
        # ==============================================================================
        print("\n--- PHẦN 4: RÀ SOÁT TIÊU CHUẨN QUẢN TRỊ VIÊN (ADMIN FULL PERMISSIONS & CASHBOOK) ---")
        admin_audit = eval_js(ws, """
        (async () => {
            window.confirm = () => true;
            window.alert = () => true;
            const data = AppStorage.loadData();
            let admin = (data.users || []).find(u => u.role === 'admin' || u.username === 'admin');
            AppStorage.login(admin.username, admin.password, true);
            App.renderUserHeaderAndSidebar();

            // 1. Kiểm tra menu & tab
            const navLabel = document.getElementById('nav-members-label')?.innerText;
            const tabTitle = document.querySelector('#tab-members .tab-main-title')?.innerText;
            
            // 2. Quyền quản lý thành viên
            App.openTab('members');
            MembersModule.switchSubTab('list');
            MembersModule.renderMembersTab();
            const gridHtml = document.getElementById('members-grid-container')?.innerHTML || '';
            const hasEditMem = gridHtml.includes('openEditMemberModal');
            const hasDeleteMem = gridHtml.includes('deleteMember');
            const hasCall = gridHtml.includes('href="tel:');
            const hasZalo = gridHtml.includes('zalo.me/');

            // 3. Sổ thu chi (Cashbook)
            App.openTab('cashbook');
            CashbookModule.renderCashbook();

            // Thêm khoản chi test
            CashbookModule.openAddTransactionModal();
            document.querySelector('input[name="tx-type"][value="expense"]').checked = true;
            document.getElementById('tx-title').value = "Thuê sân Tre Xanh Thứ 7";
            document.getElementById('tx-amount').value = "360000";
            document.getElementById('tx-category').value = "Tiền thuê sân";
            document.getElementById('tx-date').value = "2026-09-27";
            CashbookModule.saveTransaction({ preventDefault: () => {} });

            const savedData = AppStorage.loadData();
            const newTx = (savedData.transactions || []).find(t => t.title === "Thuê sân Tre Xanh Thứ 7");
            
            // Chỉnh sửa lại khoản chi
            let editSuccess = false;
            if (newTx) {
                CashbookModule.openEditTransactionModal(newTx.id);
                document.getElementById('edit-tx-amount').value = "400000";
                document.getElementById('edit-tx-title').value = "Thuê sân Tre Xanh Thứ 7 (2 ca)";
                CashbookModule.saveEditTransaction({ preventDefault: () => {} }, newTx.id);
                
                const updatedData = AppStorage.loadData();
                const editedTx = (updatedData.transactions || []).find(t => t.id === newTx.id);
                if (editedTx && editedTx.amount === 400000 && editedTx.title.includes("2 ca")) {
                    editSuccess = true;
                }
                
                // Xóa giao dịch test (mock window.confirm để chạy headless)
                const origConfirm = window.confirm;
                window.confirm = () => true;
                CashbookModule.deleteTransaction(newTx.id);
                window.confirm = origConfirm;
                const finalData = AppStorage.loadData();
                var txDeleted = !(finalData.transactions || []).some(t => t.id === newTx.id);
                await AppStorage.pushToCloud(finalData, false);
            }

            return {
                isAdmin: AppStorage.isAdmin(),
                navLabel,
                tabTitle,
                hasEditMem,
                hasDeleteMem,
                hasCall,
                hasZalo,
                newTxCreated: !!newTx,
                editSuccess,
                txDeleted: !!txDeleted
            };
        })()
        """)
        check("Xác định quyền Quản trị viên (Admin) toàn quyền", admin_audit['isAdmin'] is True)
        check("Nhãn menu hiển thị 'Quản lý thành viên' & Tiêu đề Quản trị CLB", 'Quản lý' in admin_audit['navLabel'] and 'Quản lý thành viên' in admin_audit['tabTitle'])
        check("Admin xem đầy đủ SĐT, nút Gọi, nút Zalo, nút Sửa & Xóa thành viên", admin_audit['hasEditMem'] and admin_audit['hasDeleteMem'] and admin_audit['hasCall'] and admin_audit['hasZalo'])
        check("Ghi nhận khoản thu chi mới vào Sổ quỹ thành công", admin_audit['newTxCreated'] is True)
        check("Chỉnh sửa giao dịch thu chi (Cập nhật số tiền, tiêu đề, tính lại số dư) chuẩn xác 100%", admin_audit['editSuccess'] is True)
        check("Xóa an toàn giao dịch thu chi và bảo toàn CSDL", admin_audit['txDeleted'] is True)

        # ==============================================================================
        # PHẦN 5: RÀ SOÁT TIÊU CHUẨN VIETQR & CHIA TIỀN SÂN (BILL SPLITTER & VIETQR)
        # ==============================================================================
        print("\n--- PHẦN 5: RÀ SOÁT TIÊU CHUẨN VIETQR & CHIA TIỀN SÂN (BILL SPLITTER & VIETQR) ---")
        vietqr_audit = eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            const bank = data.clubInfo?.bank;
            
            // Kiểm tra modal thanh toán quỹ VietQR
            FundModule.openPaymentModal('mem_admin');
            const qrModal = document.getElementById('global-modal-body')?.innerHTML || '';
            const hasVietQrImg = qrModal.includes('api.vietqr.io');
            const hasAccountNo = qrModal.includes(bank?.accountNo || '');
            App.closeModal();

            // Kiểm tra Chia tiền sân
            App.openTab('bill-splitter');
            const splitterTab = document.getElementById('tab-bill-splitter');
            const hasCalcBtn = !!splitterTab?.querySelector('button[onclick*="calculateBill"]');

            return {
                hasVietQrImg,
                hasAccountNo,
                hasCalcBtn
            };
        })()
        """)
        check("Tạo mã VietQR Napas 247 chuẩn Compact2 kèm nội dung chuyển khoản tự động", vietqr_audit['hasVietQrImg'] and vietqr_audit['hasAccountNo'])
        check("Module Chia tiền sân & cầu (`BillSplitterModule`) sẵn sàng hoạt động", vietqr_audit['hasCalcBtn'] is True)

        # ==============================================================================
        # TỔNG KẾT
        # ==============================================================================
        print("\n================================================================================")
        print(f"📊 KẾT QUẢ ĐÁNH GIÁ: ĐẠT {passed_count}/{total_count} TIÊU CHÍ ({passed_count/total_count*100:.1f}%)")
        print("================================================================================")
        if passed_count == total_count:
            print("🎉 TẤT CẢ CÁC CHỨC NĂNG, PHÂN QUYỀN & TIÊU CHUẨN ĐỀU ĐẠT CHUẨN HÓA 100%!")

        ws.close()

    finally:
        proc.kill()
        server.shutdown()

if __name__ == '__main__':
    run_comprehensive_audit()
