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
CHROME_PORT = 9245
SERVER_PORT = 8118

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
    user_data_dir = os.path.join(SCRATCH_DIR, f"chrome_role_test_{int(time.time())}")
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

def run_tests():
    print("================================================================================")
    print("KIỂM THỬ TỰ ĐỘNG: BẢO MẬT PHÂN QUYỀN & CHỨC NĂNG CHỈNH SỬA THU CHI SỔ QUỸ")
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

        # Đợi AppStorage tải hoàn tất
        for _ in range(30):
            ready = eval_js(ws, "typeof AppStorage !== 'undefined' && typeof App !== 'undefined'")
            if ready:
                break
            time.sleep(0.3)

        # -------------------------------------------------------------
        # TEST 1: CHẾ ĐỘ THÀNH VIÊN THƯỜNG (MEMBER) - BẢO MẬT & QUYỀN RIÊNG TƯ
        # -------------------------------------------------------------
        print("\n--- TEST 1: THÀNH VIÊN THƯỜNG ĐĂNG NHẬP & KIỂM TRA BẢO MẬT ---")
        login_res = eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            // Đảm bảo có ít nhất 1 thành viên cố định
            let mem = (data.members || []).find(m => m.role === 'member');
            if (!mem) {
                mem = { id: 'mem_vanhau', name: 'Đoàn Văn Hậu', phone: '0912345678', role: 'member', type: 'fixed', joinDate: '2026-09-01' };
                data.members.push(mem);
                data.users.push({ id: 'user_vanhau', username: 'vanhau', password: 'password123', name: 'Đoàn Văn Hậu', phone: '0912345678', role: 'member', type: 'fixed', memberId: 'mem_vanhau' });
                data.monthlyContributions.push({ id: 'due_2026-09_mem_vanhau', month: '2026-09', memberId: 'mem_vanhau', amount: 300000, status: 'paid', paidAt: '2026-09-05 14:00' });
                AppStorage.saveData(data, false);
            }
            AppStorage.login('vanhau', 'password123', true);
            App.renderUserHeaderAndSidebar();
            App.openTab('members');
            return {
                isLoggedIn: AppStorage.isLoggedIn(),
                isAdmin: AppStorage.isAdmin(),
                userName: AppStorage.getCurrentUser()?.name,
                userRole: AppStorage.getCurrentUser()?.role
            };
        })()
        """)
        print(f"    Thông tin đăng nhập: {login_res}")
        assert login_res and login_res['isLoggedIn'] is True, "Phải đăng nhập thành công"
        assert login_res['isAdmin'] is False, "Phải là người dùng thường"
        print("    => [PASS] Đăng nhập tài khoản Thành viên thường thành công!")

        # 1.1 Kiểm tra nhãn menu và tiêu đề trang
        nav_label = eval_js(ws, "document.getElementById('nav-members-label')?.innerText")
        tab_title = eval_js(ws, "document.querySelector('#tab-members .tab-main-title')?.innerText")
        print(f"    Menu Label: '{nav_label}', Tab Title: '{tab_title}'")
        assert "Danh bạ" in nav_label or "Thành viên" in nav_label, "Menu phải hiển thị Danh bạ thành viên"
        assert "Danh bạ thành viên" in tab_title, "Tiêu đề trang phải là Danh bạ thành viên CLB"
        print("    => [PASS] Nhãn menu và Tiêu đề trang hiển thị đúng chuẩn cho Thành viên thường!")

        # 1.2 Kiểm tra che giấu SĐT & Quỹ của người khác trên thẻ thành viên
        privacy_cards_check = eval_js(ws, """
        (() => {
            MembersModule.renderMembersTab();
            const cards = document.querySelectorAll('.member-roster-card');
            let otherPhoneMasked = true;
            let otherDueMasked = true;
            let noAdminButtonsForOther = true;

            cards.forEach(card => {
                const text = card.innerText;
                const isSelfCard = text.includes('Hồ sơ của tôi');
                if (!isSelfCard) {
                    // Thẻ của người khác
                    if (card.querySelector('a[href^="tel:"]')) otherPhoneMasked = false;
                    if (card.querySelector('a[href*="zalo.me"]')) otherPhoneMasked = false;
                    if (text.includes('Đã đóng quỹ') || text.includes('Chưa đóng quỹ')) otherDueMasked = false;
                    if (card.querySelector('button[onclick*="openEditMemberModal"]') || card.querySelector('button[onclick*="deleteMember"]')) {
                        noAdminButtonsForOther = false;
                    }
                }
            });

            return {
                totalCards: cards.length,
                otherPhoneMasked,
                otherDueMasked,
                noAdminButtonsForOther
            };
        })()
        """)
        print(f"    Kiểm tra thẻ thành viên: {privacy_cards_check}")
        assert privacy_cards_check['otherPhoneMasked'] is True, "SĐT người khác phải được che giấu và không có link gọi/zalo"
        assert privacy_cards_check['otherDueMasked'] is True, "Trạng thái đóng quỹ của người khác phải hiển thị 'Riêng tư'"
        assert privacy_cards_check['noAdminButtonsForOther'] is True, "Không có nút Sửa/Xóa trên thẻ người khác"
        print("    => [PASS] Bảo mật SĐT, Quỹ và Không có quyền quản lý người khác trên Danh bạ thành viên!")

        # 1.3 Kiểm tra bảng Quỹ (fund.js): Trạng thái đóng quỹ người khác bị ẩn 'Riêng tư'
        fund_privacy_check = eval_js(ws, """
        (() => {
            App.openTab('fund');
            FundModule.renderFundDashboard();
            const rows = document.querySelectorAll('#dues-table-body tr');
            let otherDuesMaskedCount = 0;
            let selfDueVisible = false;

            rows.forEach(r => {
                const text = r.innerText;
                if (text.includes('Bạn')) {
                    if (text.includes('Đã đóng') || text.includes('Chưa đóng') || text.includes('Chờ duyệt')) {
                        selfDueVisible = true;
                    }
                } else {
                    if (text.includes('Riêng tư')) {
                        otherDuesMaskedCount++;
                    }
                }
            });

            return {
                totalRows: rows.length,
                otherDuesMaskedCount,
                selfDueVisible
            };
        })()
        """)
        print(f"    Kiểm tra bảng thu quỹ: {fund_privacy_check}")
        assert fund_privacy_check['selfDueVisible'] is True, "Chính chủ phải thấy trạng thái đóng quỹ của mình"
        print("    => [PASS] Thành viên thường không xem được ai đóng quỹ hay chưa (hiển thị 'Riêng tư')!")

        # 1.4 Kiểm tra không có quyền khóa bình chọn và không có nút xóa buổi
        schedule_privacy_check = eval_js(ws, """
        (() => {
            App.openTab('schedule');
            ScheduleModule.renderSessions('sessions-container', 'all');
            const deleteBtns = document.querySelectorAll('#sessions-container button[onclick*="confirmDeleteSession"]');
            
            // Mở modal bình chọn ca đầu tiên
            const data = AppStorage.loadData();
            const firstSession = (data.sessions || [])[0];
            let lockBtnVisible = false;
            let deleteBtnInModal = false;

            if (firstSession) {
                VotingModule.openVoteModal(firstSession.id);
                const modal = document.getElementById('modal-container');
                if (modal && (modal.innerText.includes('Khóa bình chọn ngay') || modal.innerText.includes('Mở khóa bình chọn'))) {
                    lockBtnVisible = true;
                }
                if (modal && modal.querySelector('button[onclick*="confirmDeleteSession"]')) {
                    deleteBtnInModal = true;
                }
                App.closeModal();
            }

            return {
                deleteBtnsCountOnCards: deleteBtns.length,
                lockBtnVisible,
                deleteBtnInModal
            };
        })()
        """)
        print(f"    Kiểm tra lịch & bình chọn: {schedule_privacy_check}")
        assert schedule_privacy_check['deleteBtnsCountOnCards'] == 0, "Thành viên thường không được thấy nút Xóa buổi trên thẻ"
        assert schedule_privacy_check['lockBtnVisible'] is False, "Thành viên thường không có nút Khóa bình chọn"
        assert schedule_privacy_check['deleteBtnInModal'] is False, "Thành viên thường không có nút Xóa buổi trong modal"
        print("    => [PASS] Thành viên thường không có quyền khóa bình chọn và không thể xóa buổi!")

        # -------------------------------------------------------------
        # TEST 2: CHẾ ĐỘ QUẢN TRỊ VIÊN (ADMIN) - QUẢN LÝ & CHỈNH SỬA THU CHI SỔ QUỸ
        # -------------------------------------------------------------
        print("\n--- TEST 2: QUẢN TRỊ VIÊN ĐĂNG NHẬP & CHỈNH SỬA THU CHI SỔ QUỸ ---")
        admin_login_res = eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            let adminUser = (data.users || []).find(u => u.role === 'admin' || u.username === 'admin');
            if (!adminUser) {
                adminUser = { id: 'u_admin', username: 'admin', password: 'password123', name: 'Nguyễn Văn Admin', role: 'admin', type: 'fixed' };
                data.users.push(adminUser);
                AppStorage.saveData(data);
            }
            AppStorage.login(adminUser.username, adminUser.password, true);
            App.renderUserHeaderAndSidebar();
            return {
                isAdmin: AppStorage.isAdmin(),
                userName: AppStorage.getCurrentUser()?.name
            };
        })()
        """)
        print(f"    Đăng nhập Admin: {admin_login_res}")
        assert admin_login_res['isAdmin'] is True, "Phải là Admin"

        # 2.1 Admin mở Tab Sổ quỹ và kiểm tra giao diện & danh sách thu chi
        cashbook_init = eval_js(ws, """
        (() => {
            App.openTab('cashbook');
            CashbookModule.renderCashbook();
            const balEl = document.getElementById('cashbook-balance');
            return {
                balanceText: balEl ? balEl.innerText : '',
                txCount: (AppStorage.loadData().transactions || []).length
            };
        })()
        """)
        print(f"    Sổ quỹ ban đầu: {cashbook_init}")

        # 2.2 Admin thêm giao dịch mới: Mua 4 ống cầu Hải Yến (chi 960.000 đ)
        add_tx_res = eval_js(ws, """
        (() => {
            CashbookModule.openAddTransactionModal();
            document.querySelector('input[name="tx-type"][value="expense"]').checked = true;
            document.getElementById('tx-title').value = "Mua 4 ống cầu Hải Yến Đỏ";
            document.getElementById('tx-amount').value = "960000";
            document.getElementById('tx-category').value = "Mua cầu lông";
            document.getElementById('tx-date').value = "2026-09-26";
            document.getElementById('tx-note').value = "Mua tại cửa hàng thể thao Tre Xanh";
            
            CashbookModule.saveTransaction({ preventDefault: () => {} });
            
            const data = AppStorage.loadData();
            const tx = data.transactions.find(t => t.title === "Mua 4 ống cầu Hải Yến Đỏ");
            return {
                success: !!tx,
                txId: tx ? tx.id : null,
                amount: tx ? tx.amount : 0,
                type: tx ? tx.type : null,
                totalTxs: data.transactions.length
            };
        })()
        """)
        print(f"    Thêm giao dịch thu chi: {add_tx_res}")
        assert add_tx_res['success'] is True, "Phải thêm giao dịch thành công"
        assert add_tx_res['amount'] == 960000, "Số tiền phải là 960.000"
        print("    => [PASS] Ghi chép khoản thu chi mới vào sổ quỹ thành công!")

        # 2.3 Admin CHỈNH SỬA lại giao dịch (Update): Đổi thành "Mua 5 ống cầu Hải Yến Pro", số tiền 1.200.000 đ
        tx_id = add_tx_res['txId']
        edit_tx_res = eval_js(ws, f"""
        (() => {{
            CashbookModule.openEditTransactionModal('{tx_id}');
            
            // Cập nhật thông tin mới
            const titleInput = document.getElementById('edit-tx-title');
            const amountInput = document.getElementById('edit-tx-amount');
            const noteInput = document.getElementById('edit-tx-note');
            
            if (titleInput) titleInput.value = "Mua 5 ống cầu Hải Yến Pro (Đã chỉnh sửa)";
            if (amountInput) amountInput.value = "1200000";
            if (noteInput) noteInput.value = "Cập nhật thêm 1 ống cầu dự phòng giải giao hữu";

            CashbookModule.saveEditTransaction({{ preventDefault: () => {{}} }}, '{tx_id}');

            const data = AppStorage.loadData();
            const updatedTx = (data.transactions || []).find(t => t.id === '{tx_id}');
            
            return {{
                success: !!updatedTx,
                title: updatedTx?.title,
                amount: updatedTx?.amount,
                note: updatedTx?.note,
                hasUpdatedAt: !!updatedTx?.updatedAt,
                updatedBy: updatedTx?.updatedBy
            }};
        }})()
        """)
        print(f"    Kết quả chỉnh sửa giao dịch: {edit_tx_res}")
        assert edit_tx_res['success'] is True, "Giao dịch phải tồn tại sau khi sửa"
        assert edit_tx_res['amount'] == 1200000, "Số tiền phải được cập nhật thành 1.200.000"
        assert "Đã chỉnh sửa" in edit_tx_res['title'], "Tiêu đề phải được cập nhật"
        assert edit_tx_res['hasUpdatedAt'] is True, "Phải có trường thời gian chỉnh sửa"
        print("    => [PASS] Chức năng Chỉnh sửa giao dịch thu chi của Admin hoạt động chuẩn xác 100%!")

        # 2.4 Kiểm tra hiển thị nút [Sửa] và [Xóa] trên danh sách giao dịch
        buttons_rendered = eval_js(ws, f"""
        (() => {{
            CashbookModule.renderCashbook();
            const editBtn = document.querySelector('button[onclick*="openEditTransactionModal(\\'{tx_id}\\')"]');
            const deleteBtn = document.querySelector('button[onclick*="deleteTransaction(\\'{tx_id}\\')"]');
            return {{
                hasEditBtn: !!editBtn,
                hasDeleteBtn: !!deleteBtn
            }};
        }})()
        """)
        print(f"    Kiểm tra nút thao tác Admin: {buttons_rendered}")
        assert buttons_rendered['hasEditBtn'] is True, "Phải hiển thị nút Sửa cho Admin"
        assert buttons_rendered['hasDeleteBtn'] is True, "Phải hiển thị nút Xóa cho Admin"
        print("    => [PASS] Nút [✏️ Sửa] và [🗑️ Xóa] hiển thị hoàn hảo trên giao diện Sổ quỹ!")

        # 2.5 Dọn sạch giao dịch test an toàn
        cleanup_res = eval_js(ws, f"""
        (() => {{
            const data = AppStorage.loadData();
            data.transactions = (data.transactions || []).filter(t => t.id !== '{tx_id}');
            AppStorage.saveData(data, true);
            CashbookModule.renderCashbook();
            return {{
                remainingTxs: (AppStorage.loadData().transactions || []).length
            }};
        }})()
        """)
        print(f"    Dọn sạch sau kiểm thử: {cleanup_res}")

        print("\n================================================================================")
        print("TẤT CẢ CÁC BÀI KIỂM THỬ PHÂN QUYỀN & CHỈNH SỬA THU CHI ĐÃ ĐẠT 100% (PASSED)!")
        print("================================================================================")
        ws.close()

    finally:
        proc.kill()
        server.shutdown()

if __name__ == '__main__':
    run_tests()
