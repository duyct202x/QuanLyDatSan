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
CHROME_PORT = 9249
SERVER_PORT = 8119

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
    user_data_dir = os.path.join(SCRATCH_DIR, f"chrome_vote_test_{int(time.time())}")
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
    print("KIỂM THỬ TỰ ĐỘNG: QUY TRÌNH BÌNH CHỌN ĐẶT SÂN & BẢO TOÀN DỮ LIỆU KHI TẢI LẠI TRANG")
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

        print("[OK] Trang web đã tải thành công!")

        # -------------------------------------------------------------
        # TEST 1: ĐĂNG KÝ TÀI KHOẢN THÀNH VIÊN & KIỂM TRA MAPPING USER <-> MEMBER
        # -------------------------------------------------------------
        print("\n--- TEST 1: Tạo tài khoản thành viên mới và kiểm tra liên kết id ---")
        reg_result = eval_js(ws, """
        (() => {
            const regRes = AppStorage.register({
                name: 'Nguyễn Quang Hải',
                phone: '0912345678',
                password: 'hai123',
                confirmPassword: 'hai123',
                memberType: 'fixed',
                remember: true
            });
            const data = AppStorage.loadData();
            const curUser = AppStorage.getCurrentUser();
            const member = data.members.find(m => m.phone === '0912345678');
            return {
                success: regRes.success,
                message: regRes.message,
                userId: curUser ? curUser.id : null,
                memberId: curUser ? curUser.memberId : null,
                foundMemberId: member ? member.id : null,
                memberName: member ? member.name : null
            };
        })()
        """)
        print(f"Kết quả đăng ký thành viên: {reg_result}")
        assert reg_result['success'] == True, f"Đăng ký thành viên thất bại: {reg_result.get('message')}"
        assert reg_result['userId'] is not None and reg_result['userId'].startswith('user_'), "userId không hợp lệ"
        assert reg_result['memberId'] is not None and reg_result['memberId'].startswith('mem_'), "memberId không hợp lệ"
        assert reg_result['memberId'] == reg_result['foundMemberId'], "memberId của user không khớp với member trong database"
        print("[PASS] TEST 1: Tạo thành viên và liên kết tài khoản 1:1 thành công!")

        # -------------------------------------------------------------
        # TEST 2: THÀNH VIÊN VOTE THAM GIA CA ĐÁNH ĐƠN (STANDARD SESSION)
        # -------------------------------------------------------------
        print("\n--- TEST 2: Thành viên bình chọn 'Tham gia' (+1 khách) ca đánh tiêu chuẩn ---")
        # Tạo ca đánh mẫu
        eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            data.sessions = [{
                id: "ses_standard_test",
                title: "Giao lưu cầu lông tối Thứ 4",
                date: "2026-10-15",
                startTime: "18:00",
                endTime: "20:00",
                courtName: "Sân Cầu Lông Kỳ Hòa",
                courtNumbers: "Sân 1 & 2",
                courtAddress: "238 đường 3/2, Q.10",
                maxPlayers: 8,
                sessionType: "fixed",
                voteMode: "standard",
                shuttleType: "Hải Yến Pro",
                status: "open",
                votes: []
            }];
            AppStorage.saveData(data);
            ScheduleModule.renderSessions('sessions-container', 'upcoming');
        })()
        """)

        # Thành viên mở modal vote và gửi vote 'going' + 1 guest
        vote_submit_res = eval_js(ws, """
        (() => {
            VotingModule.selectedVoteStatus = 'going';
            VotingModule.guestCount = 1;
            VotingModule.submitVote('ses_standard_test');
            
            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_standard_test');
            const vote = session.votes.find(v => v.memberId === AppStorage.getCurrentUser().memberId);
            return {
                voteCount: session.votes.length,
                voteRecord: vote
            };
        })()
        """)
        print(f"Kết quả lưu vote: {vote_submit_res}")
        assert vote_submit_res['voteCount'] == 1, "Phiếu vote không được lưu vào session"
        assert vote_submit_res['voteRecord']['status'] == 'going', "Trạng thái vote không đúng"
        assert vote_submit_res['voteRecord']['guests'] == 1, "Số khách dẫn kèm không đúng"
        print("[PASS] Thành viên đã vote thành công!")

        # -------------------------------------------------------------
        # TEST 3: BẢO TOÀN DỮ LIỆU KHI TẢI LẠI TRANG (PAGE RELOAD & SCHEMA RECONCILIATION)
        # -------------------------------------------------------------
        print("\n--- TEST 3: Tải lại trang (F5 Reload) và kiểm tra tính bền vững của phiếu bình chọn ---")
        send_cdp(ws, "Page.reload")
        time.sleep(1.5)

        for _ in range(30):
            ready = eval_js(ws, "typeof AppStorage !== 'undefined' && typeof ScheduleModule !== 'undefined'")
            if ready:
                break
            time.sleep(0.3)

        reload_check = eval_js(ws, """
        (() => {
            App.openTab('schedule');
            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_standard_test');
            const currentUser = AppStorage.getCurrentUser();
            
            // Render giao diện để kiểm tra badge
            ScheduleModule.renderSessions('sessions-container', 'upcoming');
            const containerHtml = document.getElementById('sessions-container')?.innerHTML || '';
            
            return {
                isLoggedIn: AppStorage.isLoggedIn(),
                username: currentUser ? currentUser.username : null,
                sessionFound: !!session,
                votesCount: session ? session.votes.length : 0,
                vote: session ? session.votes[0] : null,
                hasBadgeInUi: containerHtml.includes('Đã đăng ký tham gia (+1 bạn)') || containerHtml.includes('Đã đăng ký tham gia')
            };
        })()
        """)
        print(f"Kiểm tra sau Reload: {reload_check}")
        assert reload_check['isLoggedIn'] == True, "Phiên đăng nhập bị mất sau reload"
        assert reload_check['votesCount'] == 1, f"Phiếu vote bị xóa sau reload! votesCount = {reload_check['votesCount']}"
        assert reload_check['vote']['status'] == 'going', "Phiếu vote sau reload không còn đúng trạng thái"
        assert reload_check['hasBadgeInUi'] == True, "UI không hiển thị badge 'Đã đăng ký tham gia' của thành viên"
        print("[PASS] TEST 3: Phiếu bình chọn được BẢO TOÀN 100% sau khi tải lại trang!")

        # -------------------------------------------------------------
        # TEST 4: THÀNH VIÊN ĐỔI TRẠNG THÁI SANG BÁO VẮNG (NOT GOING)
        # -------------------------------------------------------------
        print("\n--- TEST 4: Thành viên thay đổi vote sang 'Báo vắng / Không đi' ---")
        change_vote_res = eval_js(ws, """
        (() => {
            VotingModule.selectedVoteStatus = 'not_going';
            VotingModule.guestCount = 0;
            VotingModule.submitVote('ses_standard_test');
            
            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_standard_test');
            const vote = session.votes[0];
            return {
                votesCount: session.votes.length,
                status: vote.status,
                guests: vote.guests
            };
        })()
        """)
        print(f"Kết quả đổi vote: {change_vote_res}")
        assert change_vote_res['votesCount'] == 1, "Số lượng vote bị sai lệch sau cập nhật"
        assert change_vote_res['status'] == 'not_going', "Trạng thái vote không chuyển thành not_going"

        # Reload lại kiểm tra
        send_cdp(ws, "Page.reload")
        time.sleep(1.5)
        for _ in range(30):
            ready = eval_js(ws, "typeof AppStorage !== 'undefined'")
            if ready:
                break
            time.sleep(0.3)

        not_going_after_reload = eval_js(ws, """
        (() => {
            App.openTab('schedule');
            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_standard_test');
            ScheduleModule.renderSessions('sessions-container', 'upcoming');
            const containerHtml = document.getElementById('sessions-container')?.innerHTML || '';
            return {
                voteStatus: session.votes[0].status,
                hasNotGoingBadge: containerHtml.includes('Báo vắng buổi này')
            };
        })()
        """)
        print(f"Kiểm tra Báo vắng sau Reload: {not_going_after_reload}")
        assert not_going_after_reload['voteStatus'] == 'not_going', "Trạng thái báo vắng không bền vững"
        assert not_going_after_reload['hasNotGoingBadge'] == True, "UI không hiển thị badge 'Báo vắng buổi này'"
        print("[PASS] TEST 4: Thay đổi trạng thái bình chọn hoạt động chính xác và bền vững!")

        # -------------------------------------------------------------
        # TEST 5: BÌNH CHỌN KHẢO SÁT ĐA PHƯƠNG ÁN (MULTI-OPTION POLL)
        # -------------------------------------------------------------
        print("\n--- TEST 5: Bình chọn khảo sát chọn sân & giờ đa phương án (Poll) ---")
        eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            data.sessions.push({
                id: "ses_poll_test",
                title: "Khảo sát chọn sân Thứ 7",
                date: "2026-10-18",
                startTime: "18:00",
                endTime: "20:00",
                courtName: "Đang khảo sát phương án",
                courtNumbers: "Đa sân",
                maxPlayers: 12,
                sessionType: "guest",
                voteMode: "multi_option",
                shuttleType: "Hải Yến Đỏ Pro",
                status: "open",
                options: [
                    { id: "opt_1", courtName: "Sân Kỳ Hòa (18h-20h)", price: 360000, courtNumbers: "Sân 1", date: "2026-10-18", startTime: "18:00", endTime: "20:00" },
                    { id: "opt_2", courtName: "Sân Lan Anh (19h-21h)", price: 400000, courtNumbers: "Sân 3", date: "2026-10-18", startTime: "19:00", endTime: "21:00" }
                ],
                votes: []
            });
            AppStorage.saveData(data);
        })()
        """)

        poll_vote_res = eval_js(ws, """
        (() => {
            VotingModule.selectedPollOptions = ['opt_1', 'opt_2'];
            VotingModule.pollNotGoing = false;
            VotingModule.guestCount = 0;
            VotingModule.submitMultiOptionVote('ses_poll_test');
            
            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_poll_test');
            return {
                votesCount: session.votes.length,
                vote: session.votes[0]
            };
        })()
        """)
        print(f"Kết quả vote khảo sát Poll: {poll_vote_res}")
        assert poll_vote_res['votesCount'] == 1, "Phiếu vote khảo sát không được lưu"
        assert len(poll_vote_res['vote']['selectedOptions']) == 2, "Số phương án chọn không đúng"

        # Reload lại kiểm tra
        send_cdp(ws, "Page.reload")
        time.sleep(1.5)
        for _ in range(30):
            ready = eval_js(ws, "typeof AppStorage !== 'undefined'")
            if ready:
                break
            time.sleep(0.3)

        poll_after_reload = eval_js(ws, """
        (() => {
            App.openTab('schedule');
            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_poll_test');
            ScheduleModule.renderSessions('sessions-container', 'upcoming');
            const containerHtml = document.getElementById('sessions-container')?.innerHTML || '';
            return {
                votesCount: session.votes.length,
                optionsCount: session.votes[0].selectedOptions.length,
                hasPollBadge: containerHtml.includes('Đã vote 2 phương án')
            };
        })()
        """)
        print(f"Kiểm tra Poll sau Reload: {poll_after_reload}")
        assert poll_after_reload['votesCount'] == 1, "Phiếu vote khảo sát bị mất sau reload"
        assert poll_after_reload['optionsCount'] == 2, "Dữ liệu phương án đã chọn bị sai lệch"
        assert poll_after_reload['hasPollBadge'] == True, "UI không hiển thị 'Đã vote 2 phương án'"
        print("[PASS] TEST 5: Bình chọn khảo sát đa phương án lưu trữ và hiển thị hoàn hảo!")

        # -------------------------------------------------------------
        # TEST 6: ADMIN THÊM THÀNH VIÊN THỦ CÔNG VÀO DANH SÁCH
        # -------------------------------------------------------------
        print("\n--- TEST 6: Quản trị viên (Admin) thêm thành viên thủ công ---")
        eval_js(ws, "AppStorage.login('admin', 'admin123', true);")
        time.sleep(0.5)

        admin_add_res = eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            const member = data.members.find(m => m.phone === '0912345678');
            
            // Set inputs
            document.body.innerHTML += `
                <select id="manual-member-id"><option value="${member.id}">${member.name}</option></select>
                <select id="manual-status"><option value="going">Đi</option></select>
                <input type="number" id="manual-guests" value="2">
            `;
            VotingModule.saveManualAdd('ses_standard_test');
            
            const freshData = AppStorage.loadData();
            const session = freshData.sessions.find(s => s.id === 'ses_standard_test');
            const quanghaiVote = session.votes.find(v => v.memberId === member.id);
            return {
                totalVotes: session.votes.length,
                vote: quanghaiVote
            };
        })()
        """)
        print(f"Kết quả Admin thêm thủ công: {admin_add_res}")
        assert admin_add_res['vote']['status'] == 'going', "Vote không được cập nhật thành going"
        assert admin_add_res['vote']['guests'] == 2, "Số khách dẫn kèm không đúng"
        print("[PASS] TEST 6: Admin thêm thành viên thủ công hoạt động chuẩn xác!")

        # -------------------------------------------------------------
        # TEST 7: KHỬ TRÙNG LẶP BÌNH CHỌN (1 THÀNH VIÊN VOTE NHIỀU LẦN CHỈ ĐƯỢC 1 PHIẾU ACTIVE)
        # -------------------------------------------------------------
        print("\n--- TEST 7: Khử trùng lặp bình chọn khi 1 thành viên vote 3 lần liên tiếp ---")
        eval_js(ws, "AppStorage.login('0912345678', 'hai123', true);")
        time.sleep(0.3)

        dedup_res = eval_js(ws, """
        (() => {
            // Lần 1: Vote going
            VotingModule.selectedVoteStatus = 'going';
            VotingModule.guestCount = 0;
            VotingModule.submitVote('ses_standard_test');

            // Lần 2: Vote maybe
            VotingModule.selectedVoteStatus = 'maybe';
            VotingModule.guestCount = 0;
            VotingModule.submitVote('ses_standard_test');

            // Lần 3: Vote going + 2 khách
            VotingModule.selectedVoteStatus = 'going';
            VotingModule.guestCount = 2;
            VotingModule.submitVote('ses_standard_test');

            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_standard_test');
            const memberVotes = session.votes.filter(v => v.memberId === AppStorage.getCurrentUser().memberId);
            
            // Render modal để kiểm tra danh sách hiển thị
            ScheduleModule.openSessionDetailsModal('ses_standard_test');
            const modalHtml = document.getElementById('global-modal-body')?.innerHTML || '';

            return {
                totalSessionVotes: session.votes.length,
                memberVoteCount: memberVotes.length,
                activeVote: memberVotes[0],
                modalTitleGoing: modalHtml.includes('Danh sách tham gia (1 người + 2 khách)'),
                historyCount: (session.voteHistory || []).length
            };
        })()
        """)
        print(f"Kết quả kiểm tra khử trùng lặp: {dedup_res}")
        assert dedup_res['memberVoteCount'] == 1, f"Bị trùng lặp phiếu! memberVoteCount = {dedup_res['memberVoteCount']}"
        assert dedup_res['activeVote']['status'] == 'going' and dedup_res['activeVote']['guests'] == 2, "Phiếu active cuối cùng không đúng"
        assert dedup_res['modalTitleGoing'] == True, "Modal không hiển thị đúng tổng số lượng người sau khử trùng lặp"
        print("[PASS] TEST 7: Khử trùng lặp triệt để thành công! (1 thành viên = 1 phiếu duy nhất)")

        # -------------------------------------------------------------
        # TEST 8: BẢO LƯU & KẾT XUẤT LỊCH SỬ BÌNH CHỌN (VOTE HISTORY TIMELINE)
        # -------------------------------------------------------------
        print("\n--- TEST 8: Kiểm tra dòng thời gian lịch sử bình chọn (Vote History Timeline) ---")
        history_res = eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_standard_test');
            const history = session.voteHistory || [];
            
            ScheduleModule.openSessionDetailsModal('ses_standard_test');
            const modalHtml = document.getElementById('global-modal-body')?.innerHTML || '';

            return {
                historyCount: history.length,
                hasTimelineInModal: modalHtml.includes('vote-history-timeline') || modalHtml.includes('Lịch sử bình chọn') || modalHtml.includes('vote-history-card'),
                latestHistoryAction: history.length > 0 ? history[history.length - 1].actionText : '',
                hasMemberNameInHistory: history.some(h => h.memberName === 'Nguyễn Quang Hải')
            };
        })()
        """)
        print(f"Kết quả kiểm tra Lịch sử bình chọn: {history_res}")
        assert history_res['historyCount'] >= 3, f"Lịch sử bình chọn không ghi nhận đủ các lần đổi! historyCount = {history_res['historyCount']}"
        assert history_res['hasTimelineInModal'] == True, "Giao diện modal không có khối 'Lịch sử bình chọn & thay đổi'"
        assert history_res['hasMemberNameInHistory'] == True, "Lịch sử không ghi nhận tên thành viên"
        print("[PASS] TEST 8: Ghi nhận và hiển thị lịch sử bình chọn chi tiết thành công!")

        # -------------------------------------------------------------
        # TEST 9: QUY TẮC KHÓA ĐỔI LỊCH TRƯỚC 2 NGÀY (48H STRICT LOCKOUT)
        # -------------------------------------------------------------
        print("\n--- TEST 9: Kiểm tra khóa đổi lịch & vote trước 2 ngày (48h Lock) đối với thành viên ---")
        lock_res = eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            // Tạo ca đánh diễn ra ngày mai (cách < 48 giờ)
            const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const tomorrowStr = tomorrow.toISOString().slice(0, 10);
            
            data.sessions.push({
                id: "ses_lock_test_48h",
                title: "Ca đánh gấp ngày mai (Trong 48h)",
                date: tomorrowStr,
                startTime: "18:00",
                endTime: "20:00",
                courtName: "Sân Tre Xanh",
                courtNumbers: "Sân 1",
                maxPlayers: 6,
                sessionType: "fixed",
                voteMode: "standard",
                status: "open",
                votes: []
            });
            AppStorage.saveData(data);

            // Đăng nhập thành viên thường
            AppStorage.login('0912345678', 'hai123', true);
            const memberUser = AppStorage.getCurrentUser();
            
            const session = data.sessions.find(s => s.id === 'ses_lock_test_48h');
            const lockStatus = ScheduleModule.getVoteLockStatus(session, 48);

            // Thử submit vote khi bị khóa
            const votesBefore = session.votes.length;
            VotingModule.submitVote('ses_lock_test_48h');
            const dataAfter = AppStorage.loadData();
            const sessionAfter = dataAfter.sessions.find(s => s.id === 'ses_lock_test_48h');
            const votesAfter = sessionAfter.votes.length;

            // Kiểm tra giao diện modal chi tiết
            ScheduleModule.openSessionDetailsModal('ses_lock_test_48h');
            const modalHtml = document.getElementById('global-modal-body')?.innerHTML || '';

            return {
                isMember: memberUser.role === 'member',
                isLocked: lockStatus.isLocked,
                votesBefore,
                votesAfter,
                wasBlocked: votesBefore === votesAfter,
                hasLockedNoticeInModal: modalHtml.includes('Khóa đổi lịch (Trước 2 ngày)'),
                hasDisabledButton: modalHtml.includes('disabled') && modalHtml.includes('Đã chốt danh sách')
            };
        })()
        """)
        print(f"Kết quả kiểm tra khóa 48h: {lock_res}")
        assert lock_res['isLocked'] == True, "Ca đánh trong 48h không được đánh dấu là isLocked = true"
        assert lock_res['wasBlocked'] == True, "Thành viên thường vẫn có thể gửi vote dù đã khóa trước 2 ngày!"
        assert lock_res['hasLockedNoticeInModal'] == True, "Modal không hiển thị cảnh báo khóa đổi lịch trước 2 ngày"
        assert lock_res['hasDisabledButton'] == True, "Nút bình chọn không bị vô hiệu hóa (disabled)"
        print("[PASS] TEST 9: Quy tắc khóa trước 2 ngày hoạt động hoàn hảo và chặn 100% đổi lịch từ thành viên!")

        # -------------------------------------------------------------
        # TEST 10: ADMIN CÓ QUYỀN ĐIỀU CHỈNH DÙ ĐÃ QUA HẠN 48H
        # -------------------------------------------------------------
        print("\n--- TEST 10: Quản trị viên (Admin) vẫn có quyền quản lý và cập nhật sau hạn 48h ---")
        admin_override_res = eval_js(ws, """
        (() => {
            // Đăng nhập Admin
            AppStorage.login('admin', 'admin', true);
            const adminUser = AppStorage.getCurrentUser();
            
            // Admin mở modal chi tiết
            ScheduleModule.openSessionDetailsModal('ses_lock_test_48h');
            const modalHtml = document.getElementById('global-modal-body')?.innerHTML || '';

            // Admin vote hoặc thêm thủ công
            VotingModule.selectedVoteStatus = 'going';
            VotingModule.guestCount = 0;
            VotingModule.submitVote('ses_lock_test_48h');

            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_lock_test_48h');

            return {
                isAdmin: adminUser.role === 'admin',
                adminButtonText: modalHtml.includes('Quản lý bình chọn (Admin)'),
                adminVoteSaved: session.votes.length === 1
            };
        })()
        """)
        print(f"Kết quả kiểm tra quyền Admin: {admin_override_res}")
        assert admin_override_res['isAdmin'] == True, "Không phải tài khoản admin"
        assert admin_override_res['adminButtonText'] == True, "Nút trên modal admin không đúng"
        assert admin_override_res['adminVoteSaved'] == True, "Admin không thể cập nhật danh sách khi bị khóa"
        print("[PASS] TEST 10: Admin có toàn quyền quản lý ca đánh sau hạn chốt!")

        print("\n================================================================================")
        print("TẤT CẢ 10/10 BƯỚC KIỂM THỬ ĐÃ VƯỢT QUA 100% THÀNH CÔNG!")
        print("================================================================================")

    finally:
        try:
            ws.close()
        except Exception:
            pass
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            server.shutdown()
        except Exception:
            pass

if __name__ == '__main__':
    run_tests()
