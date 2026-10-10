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
CHROME_PORT = 9250
SERVER_PORT = 8120

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
    user_data_dir = os.path.join(SCRATCH_DIR, f"chrome_vh_test_{int(time.time())}")
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

def run():
    print("================================================================================")
    print("KIỂM THỬ TỰ ĐỘNG: GHI NHẬN & HIỂN THỊ LỊCH SỬ BÌNH CHỌN (VOTE HISTORY)")
    print("================================================================================")
    server = start_local_server()
    proc = start_browser()
    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json")
        tabs = json.loads(req.read().decode())
        ws_url = tabs[0]["webSocketDebuggerUrl"]
        for t in tabs:
            if t.get("type") == "page":
                ws_url = t.get("webSocketDebuggerUrl")
                break

        ws = websocket.create_connection(ws_url)
        send_cdp(ws, "Page.enable")
        send_cdp(ws, "Runtime.enable")

        for _ in range(30):
            if eval_js(ws, "typeof AppStorage !== 'undefined' && typeof App !== 'undefined'"):
                break
            time.sleep(0.3)

        print("[OK] Kết nối ứng dụng thành công!")

        # 1. Đăng ký và đăng nhập
        eval_js(ws, """
        (() => {
            const reg = AppStorage.register({
                name: 'Trần Đình Trọng',
                phone: '0988112233',
                password: 'pass123',
                confirmPassword: 'pass123',
                memberType: 'fixed',
                remember: true
            });
            AppStorage.login('0988112233', 'pass123', true);
            const data = AppStorage.loadData();
            data.sessions = [{
                id: "ses_vh_demo",
                title: "Trận Cầu Lông Tối Thứ 6",
                date: "2026-10-20",
                startTime: "18:30",
                endTime: "20:30",
                courtName: "Sân Cầu Lông Tre Xanh",
                courtNumbers: "Sân 2",
                maxPlayers: 8,
                sessionType: "fixed",
                voteMode: "standard",
                status: "open",
                votes: [],
                voteHistory: []
            }];
            AppStorage.saveData(data);
        })()
        """)

        # 2. Lần 1: Vote tham gia (1 khách)
        eval_js(ws, """
        (() => {
            VotingModule.selectedVoteStatus = 'going';
            VotingModule.guestCount = 1;
            VotingModule.submitVote('ses_vh_demo');
        })()
        """)
        time.sleep(0.5)

        # 3. Lần 2: Đổi sang dự bị kèm ghi chú
        eval_js(ws, """
        (() => {
            VotingModule.selectedVoteStatus = 'maybe';
            VotingModule.guestCount = 0;
            const noteInput = document.getElementById('vote-note');
            if (noteInput) noteInput.value = 'Chờ confirm xe';
            VotingModule.submitVote('ses_vh_demo');
        })()
        """)
        time.sleep(0.5)

        # 4. Lần 3: Đổi sang báo vắng
        eval_js(ws, """
        (() => {
            VotingModule.selectedVoteStatus = 'not_going';
            VotingModule.guestCount = 0;
            VotingModule.submitVote('ses_vh_demo');
        })()
        """)
        time.sleep(0.5)

        # 5. Lần 4: Đổi lại tham gia (+0 khách)
        eval_js(ws, """
        (() => {
            VotingModule.selectedVoteStatus = 'going';
            VotingModule.guestCount = 0;
            VotingModule.submitVote('ses_vh_demo');
        })()
        """)
        time.sleep(0.5)

        # 6. Kiểm tra CSDL và Giao diện Vote Modal + Details Modal
        check_res = eval_js(ws, """
        (() => {
            const data = AppStorage.loadData();
            const session = data.sessions.find(s => s.id === 'ses_vh_demo');
            const history = session.voteHistory || [];
            
            // 1. Kiểm tra hiển thị trong Vote Modal
            VotingModule.openStandardVoteModal('ses_vh_demo');
            const voteModalHtml = document.getElementById('global-modal-body')?.innerHTML || '';
            const hasHistoryInVoteModal = voteModalHtml.includes('vote-history-timeline') && voteModalHtml.includes('Trần Đình Trọng');

            // 2. Kiểm tra hiển thị trong Session Details Modal
            ScheduleModule.openSessionDetailsModal('ses_vh_demo');
            const detailsModalHtml = document.getElementById('global-modal-body')?.innerHTML || '';
            const hasHistoryInDetailsModal = detailsModalHtml.includes('vote-history-timeline') && detailsModalHtml.includes('Trần Đình Trọng');

            return {
                totalActiveVotes: session.votes.length,
                totalHistoryEntries: history.length,
                hasHistoryInVoteModal,
                hasHistoryInDetailsModal,
                historyActions: history.map(h => h.actionText),
                historyTimes: history.map(h => h.votedAt),
                latestVoteStatus: session.votes[0].status
            };
        })()
        """)

        print(f"\nKết quả kiểm tra chi tiết:")
        print(f"- Số phiếu active: {check_res['totalActiveVotes']} (1 người = 1 phiếu)")
        print(f"- Số lượt lưu vết lịch sử: {check_res['totalHistoryEntries']} lượt")
        print(f"- Các hành động trong lịch sử: {check_res['historyActions']}")
        print(f"- Dấu thời gian ghi nhận: {check_res['historyTimes']}")
        print(f"- Hiển thị lịch sử trong Modal Bình chọn: {check_res['hasHistoryInVoteModal']}")
        print(f"- Hiển thị lịch sử trong Modal Chi tiết: {check_res['hasHistoryInDetailsModal']}")

        assert check_res['totalActiveVotes'] == 1, "Trùng lặp phiếu active!"
        assert check_res['totalHistoryEntries'] == 4, "Lịch sử không ghi nhận đủ 4 lần đổi vote!"
        assert check_res['hasHistoryInVoteModal'] == True, "Không hiển thị lịch sử trong Vote Modal!"
        assert check_res['hasHistoryInDetailsModal'] == True, "Không hiển thị lịch sử trong Details Modal!"

        print("\n[SUCCESS] Toàn bộ chu trình ghi nhận và hiển thị lịch sử bình chọn ĐẠT CHUẨN 100%!")

    finally:
        try: ws.close()
        except: pass
        try: proc.terminate()
        except: pass
        try: server.shutdown()
        except: pass

if __name__ == '__main__':
    run()
