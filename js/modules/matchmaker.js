// Badminton Doubles Matchmaking & Pair Generator Engine

const MatchmakerModule = {
  currentPlayers: [],

  init() {
    this.populateSessionSelect();
  },

  populateSessionSelect() {
    const select = document.getElementById('match-session-select');
    if (!select) return;

    const data = AppStorage.loadData();
    const sessions = data.sessions || [];

    select.innerHTML = `
      <option value="">-- Chọn buổi đánh để lấy danh sách người chơi --</option>
      ${sessions.map(s => `<option value="${s.id}">${s.title} (${s.date} - ${s.courtNumbers})</option>`).join('')}
    `;
  },

  loadSessionForMatch(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const select = document.getElementById('match-session-select');
    if (select) select.value = sessionId;

    const going = (session.votes || []).filter(v => v.status === 'going');
    const members = data.members || [];

    let playerPool = [];
    going.forEach(v => {
      const mem = members.find(m => m.id === v.memberId);
      if (mem) {
        playerPool.push({
          id: mem.id,
          name: mem.name,
          level: mem.level,
          avatar: mem.avatar
        });
      }
      // Add guests if any
      for (let i = 1; i <= (v.guests || 0); i++) {
        playerPool.push({
          id: `${v.memberId}_guest_${i}`,
          name: `Bạn của ${mem ? mem.name.split(' ').slice(-1)[0] : 'Member'} (${i})`,
          level: 'Trung Bình (C)',
          avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80'
        });
      }
    });

    this.currentPlayers = playerPool;
    this.renderPlayerPool();
  },

  handleSessionChange() {
    const select = document.getElementById('match-session-select');
    if (!select || !select.value) return;
    this.loadSessionForMatch(select.value);
  },

  renderPlayerPool() {
    const poolContainer = document.getElementById('match-player-pool');
    const countEl = document.getElementById('match-player-count');
    if (!poolContainer) return;

    if (countEl) countEl.innerText = `${this.currentPlayers.length} người chơi`;

    if (this.currentPlayers.length === 0) {
      poolContainer.innerHTML = `
        <div class="text-center text-muted" style="padding: 1.5rem; width: 100%;">
          Chưa có người chơi nào được chọn. Hãy chọn một buổi đánh có người vote đi hoặc thêm thủ công bên dưới.
        </div>
      `;
      return;
    }

    poolContainer.innerHTML = this.currentPlayers.map((p, idx) => `
      <div class="badge badge-neutral" style="padding: 0.4rem 0.75rem; display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.85rem;">
        <img class="avatar avatar-sm" src="${p.avatar}" alt="${p.name}" style="width: 22px; height: 22px;">
        <span>${p.name}</span>
        <span class="badge badge-paid" style="font-size: 0.68rem; padding: 0.1rem 0.35rem;">${p.level}</span>
        <button onclick="MatchmakerModule.removePlayer(${idx})" style="background:none; border:none; color:var(--danger); cursor:pointer; font-size:0.8rem; margin-left:0.2rem;">&times;</button>
      </div>
    `).join('');
  },

  removePlayer(index) {
    this.currentPlayers.splice(index, 1);
    this.renderPlayerPool();
  },

  addQuickPlayer() {
    const name = prompt("Nhập tên người chơi mới:");
    if (!name) return;
    const level = prompt("Nhập trình độ (A: Tốt, B: Khá, C: Trung Bình, D: Mới chơi):", "C") || "C";
    
    this.currentPlayers.push({
      id: "quick_" + Date.now(),
      name: name.trim(),
      level: `Trình ${level.toUpperCase()}`,
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=10b981&color=fff`
    });
    this.renderPlayerPool();
  },

  generateMatches() {
    if (this.currentPlayers.length < 4) {
      App.showToast("Cần ít nhất 4 người chơi để tạo một trận đánh đôi!", "warning");
      return;
    }

    const courtCount = parseInt(document.getElementById('match-court-count')?.value || '2');
    const mode = document.getElementById('match-mode')?.value || 'balanced';

    let shuffled = [...this.currentPlayers];

    if (mode === 'random') {
      shuffled.sort(() => Math.random() - 0.5);
    } else {
      // Balanced mode: Sort by level heuristic, then cross pair
      shuffled.sort((a, b) => (b.level || '').localeCompare(a.level || ''));
      const balanced = [];
      let i = 0, j = shuffled.length - 1;
      while (i <= j) {
        if (i === j) {
          balanced.push(shuffled[i]);
          break;
        }
        balanced.push(shuffled[i]);
        balanced.push(shuffled[j]);
        i++;
        j--;
      }
      shuffled = balanced;
    }

    const courtResults = [];
    let playerIdx = 0;

    for (let c = 1; c <= courtCount; c++) {
      if (playerIdx + 4 <= shuffled.length) {
        courtResults.push({
          courtNum: c,
          team1: [shuffled[playerIdx], shuffled[playerIdx + 1]],
          team2: [shuffled[playerIdx + 2], shuffled[playerIdx + 3]]
        });
        playerIdx += 4;
      }
    }

    const benchPlayers = shuffled.slice(playerIdx);

    const container = document.getElementById('match-results-container');
    if (!container) return;

    container.innerHTML = `
      <div class="matchmaker-court-grid">
        ${courtResults.map(cr => `
          <div class="match-court-card">
            <div class="match-court-header">
              <span><i class="fas fa-table-tennis"></i> SÂN ĐẤU SỐ ${cr.courtNum}</span>
              <span class="badge badge-warning">Trận Đôi Nam Nữ / Đôi Tự Do</span>
            </div>
            
            <div class="badminton-court-visual">
              <!-- Team 1 Side -->
              <div class="court-side">
                <div class="player-slot">
                  <img class="avatar avatar-sm" src="${cr.team1[0].avatar}" alt="${cr.team1[0].name}">
                  <div>
                    <div>${cr.team1[0].name}</div>
                    <span class="player-rank">${cr.team1[0].level}</span>
                  </div>
                </div>
                <div class="player-slot">
                  <img class="avatar avatar-sm" src="${cr.team1[1].avatar}" alt="${cr.team1[1].name}">
                  <div>
                    <div>${cr.team1[1].name}</div>
                    <span class="player-rank">${cr.team1[1].level}</span>
                  </div>
                </div>
              </div>

              <!-- Court Net -->
              <div class="court-net"></div>

              <!-- Team 2 Side -->
              <div class="court-side">
                <div class="player-slot">
                  <img class="avatar avatar-sm" src="${cr.team2[0].avatar}" alt="${cr.team2[0].name}">
                  <div>
                    <div>${cr.team2[0].name}</div>
                    <span class="player-rank">${cr.team2[0].level}</span>
                  </div>
                </div>
                <div class="player-slot">
                  <img class="avatar avatar-sm" src="${cr.team2[1].avatar}" alt="${cr.team2[1].name}">
                  <div>
                    <div>${cr.team2[1].name}</div>
                    <span class="player-rank">${cr.team2[1].level}</span>
                  </div>
                </div>
              </div>
            </div>

            <div style="padding: 0.75rem 1rem; display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.1); font-size: 0.82rem;">
              <span class="text-secondary">Tỷ số set (21đ):</span>
              <div style="display: flex; gap: 0.5rem; align-items: center;">
                <input type="number" placeholder="0" style="width: 45px; text-align: center; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-input); color: #fff;">
                <span>:</span>
                <input type="number" placeholder="0" style="width: 45px; text-align: center; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-input); color: #fff;">
              </div>
            </div>
          </div>
        `).join('')}
      </div>

      ${benchPlayers.length > 0 ? `
        <div class="card" style="margin-top: 1.5rem;">
          <div class="font-bold text-warning" style="margin-bottom: 0.5rem;">
            <i class="fas fa-couch"></i> Danh sách chờ lượt tiếp theo / Đổi sân (${benchPlayers.length} người):
          </div>
          <div class="flex flex-wrap gap-2">
            ${benchPlayers.map(p => `
              <span class="badge badge-neutral" style="padding: 0.4rem 0.65rem;">
                ${p.name} (${p.level})
              </span>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `;

    App.showToast("🎉 Đã xếp cặp và tạo sơ đồ sân thi đấu thành công!", "success");
  }
};
