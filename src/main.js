// Bus Broadcaster — Phase 2: Mission Control
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Reversible encoding only. This is NOT encryption: never rely on it to protect a secret.
  const { escapeHtml, safeColor } = globalThis.BBSecurity;
  // Secrets (OBS password, Twitch token) live in sessionStorage only: gone when the tab closes.
  const secretGet = (k) => { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const secretSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
  function encryptStr(text) {
    if (!text) return "";
    try { return btoa(encodeURIComponent(text)); } catch(e) { return ""; }
  }
  function decryptStr(encoded) {
    if (!encoded) return "";
    try { return decodeURIComponent(atob(encoded)); } catch(e) { return ""; }
  }

  const canvases = {
    live: $('#canvas-live'),
    out: $('#canvas-out'),
    monitor: $('#canvas-monitor')
  };
  const ctxs = {
    live: canvases.live?.getContext('2d'),
    out: canvases.out?.getContext('2d'),
    monitor: canvases.monitor?.getContext('2d')
  };

  // UI State
  const state = {
    broadcasting: false,
    heat: 0,
    heatRateBase: 4.5,
    heatRateMax: 10.0,
    coolRate: 3.0,
    gameOver: false,
    tLast: 0,

    strength: 50,
    viewership: 0,
    battery: 100,
    diesel: 100,
    generatorOn: false,
    driving: false,
    money: 0,

    // NEW: UI Logic
    messages: [],
    internalMessages: [],
    cameraStations: [
      "driver", "editing station", "dj station", "news station",
      "outside engine", "emitter locker", "outside front", "outside back",
      "side perimeter 1", "side perimeter 2", "side perimeter 3", "side perimeter 4"
    ],
    currentSpeaker: null,
    isInternalSpeakerActive: true,
    koboldInventory: ["Strange Frequency", "Rusted Key"],
    
    // Assets
    assets: {
      images: {},
      loaded: false
    },

    // OBS WebSocket Control
    obs: null,
    obsConnected: false,
    obsScenes: {
      "Dolores": "Scene_Dispatch",
      "Soren": "Scene_DJ",
      "Priya": "Scene_Engineer",
      "Marcus": "Scene_Driver",
      "Yael": "Scene_Mechanic",
      "Felix": "Scene_Lookout",
      "Prophet": "Scene_Prophet",
      "Nadia": "Scene_Nadia",
      "Standby": "Scene_Standby"
    },

    // Twitch WebSocket Control
    twitchWS: null,
    twitchConnected: false,

    // Media Deck
    mediaFiles: [],
    mediaCurrentIndex: -1,
    mediaElement: null,

    // Transmission Audio Mutes (True = Muted)
    audioMutes: {
      live: true,
      out: true,
      monitor: true
    }
  };

  const characters = [
    { name: "Dolores", color: "#FF9F45", sprite: "dispatcher-idle.svg", type: "scheduling" },
    { name: "Soren", color: "#A8E6CF", sprite: "dj-idle.svg", type: "transmitting" },
    { name: "Priya", color: "#FFD3B6", sprite: "engineer-idle.svg", type: "signalMonitor" },
    { name: "Marcus", color: "#DCEDC1", sprite: "driver-idle.svg", type: "routing" },
    { name: "Yael", color: "#FF8B94", sprite: "mechanic-idle.svg", type: "maintenance" },
    { name: "Felix", color: "#B5EAD7", sprite: "lookout-idle.svg", type: "research" },
    { name: "Prophet", color: "#E2D2FF", sprite: "prophet-idle.svg", type: "scouting" },
    { name: "Nadia", color: "#FFDAC1", sprite: "nadia-idle.svg", type: "scouting" }
  ];

  // ─── Asset Loading ──────────────────────────────────────────────────────────

  function loadAssets() {
    const toLoad = [
      ...characters.map(c => ({ name: c.name, src: './images/SVG/' + c.sprite })),
      { name: "testpattern", src: './images/SVG/testpattern.svg' },
      { name: "ui_live", src: './images/SVG/ui_live.svg' },
      { name: "ui_out", src: './images/SVG/ui_out.svg' },
      { name: "ui_monitor", src: './images/SVG/ui_monitor.svg' }
    ];
    
    let loadedCount = 0;
    const checkDone = () => {
      loadedCount++;
      if (loadedCount === toLoad.length) {
        state.assets.loaded = true;
        const tp = $('#test-pattern');
        if (tp) tp.style.display = 'none';
      }
    };

    toLoad.forEach(item => {
      const img = new Image();
      img.src = item.src;
      img.onload = () => {
        state.assets.images[item.name] = img;
        checkDone();
      };
      img.onerror = () => {
        console.warn(`Failed to load asset: ${item.src}`);
        checkDone();
      };
    });
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  function init() {
    loadAssets();
    setupEventListeners();
    
    // Load Settings
    if (localStorage.getItem('bb_obsAddress')) $('#obs-address').value = localStorage.getItem('bb_obsAddress');
    if (localStorage.getItem('bb_obsPort')) $('#obs-port').value = localStorage.getItem('bb_obsPort');
    // Earlier versions kept these in localStorage; remove those copies.
    localStorage.removeItem('bb_obsPassword');
    localStorage.removeItem('bb_twitchToken');
    if (secretGet('bb_obsPassword')) $('#obs-password').value = secretGet('bb_obsPassword');
    if (localStorage.getItem('bb_twitchChannel')) $('#twitch-channel').value = localStorage.getItem('bb_twitchChannel');
    if (secretGet('bb_twitchToken')) $('#twitch-token').value = secretGet('bb_twitchToken');

    resize();
    
    if (!loadGameState()) {
      reset();
      // Seed initial messages
      addMessage("Dolores", "Signal check. Everyone online?", false);
    }
    
    // Start simulation loops
    setInterval(simulateChat, 5000);
    setInterval(simulateSpeaker, 8000);
    setInterval(saveGameState, 2000);
    window.addEventListener('beforeunload', saveGameState);
    
    // Auto-connect chat on load if configured
    if ($('#twitch-token').value) {
      twitchConnect();
    }

    requestAnimationFrame(draw);
  }

  function setupEventListeners() {
    window.addEventListener('resize', resize);
    
    const btnRestart = $('#btn-restart');
    if (btnRestart) {
        btnRestart.addEventListener('click', () => {
          localStorage.removeItem('bb_save');
          reset();
        });
    }
    
    // Menu & Popovers
    setupPopover('menu-hamburger', 'popover-overview', renderOverview);
    setupPopover('menu-schedule', 'popover-schedule', renderSchedule);
    setupPopover('menu-inventory', 'popover-inventory', renderInventory);
    setupPopover('menu-settings', 'popover-settings');
    setupPopover('menu-media', 'popover-media');

    // OBS Control
    const btnObsConnect = $('#btn-obs-connect');
    if (btnObsConnect) btnObsConnect.addEventListener('click', obsConnect);

    // Twitch Control
    const btnTwitchConnect = $('#btn-twitch-connect');
    if (btnTwitchConnect) btnTwitchConnect.addEventListener('click', twitchConnect);
    
    // Game Controls
    const strengthInput = $('#strength');
    if (strengthInput) strengthInput.addEventListener('input', (e) => state.strength = parseInt(e.target.value));
    
    const btnGen = $('#btnGenerator');
    if (btnGen) {
        btnGen.addEventListener('click', () => {
          state.generatorOn = !state.generatorOn;
          btnGen.style.background = state.generatorOn ? 'rgba(93, 255, 183, 0.2)' : '#000';
        });
    }

    const btnDrv = $('#btnDrive');
    if (btnDrv) {
        btnDrv.addEventListener('click', () => {
          state.driving = !state.driving;
          btnDrv.style.background = state.driving ? 'rgba(255, 210, 95, 0.2)' : '#000';
        });
    }
    
    const menuKobold = $('#menu-kobold');
    if (menuKobold) {
        menuKobold.addEventListener('click', () => {
          addMessage("Kobold", "Three knocks at the side panel...", false);
        });
    }

    const speakerToggle = $('#speaker-toggle');
    if (speakerToggle) {
        speakerToggle.addEventListener('change', (e) => {
          state.isInternalSpeakerActive = e.target.checked;
        });
    }

    // Transmission Audio Toggles
    $('#mute-live').addEventListener('click', () => toggleMute('live'));
    $('#mute-out').addEventListener('click', () => toggleMute('out'));
    $('#mute-monitor').addEventListener('click', () => toggleMute('monitor'));
  }

  function toggleMute(stage) {
    state.audioMutes[stage] = !state.audioMutes[stage];
    const btn = $('#mute-' + stage);
    const isMuted = state.audioMutes[stage];

    btn.classList.toggle('unmuted', !isMuted);
    btn.textContent = isMuted ? '🔇' : '🔊';

    if (stage === 'live') {
      if (state.mediaElement) state.mediaElement.muted = isMuted;
    } else if (stage === 'out') {
      const busChannel = new BroadcastChannel('bus_broadcaster_event_bus');
      busChannel.postMessage({ type: 'MEDIA_SET_MUTE', muted: isMuted });
    } else if (stage === 'monitor') {
      if (window.twitchPlayer && window.twitchPlayer.setMuted) {
        window.twitchPlayer.setMuted(isMuted);
      }
    }
  }

  function setupPopover(btnId, popoverId, onShow) {
    const btn = $('#' + btnId);
    if (!btn) return;
    const pop = $('#' + popoverId);
    if (!pop) return;
    
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = pop.style.display === 'block';
      document.querySelectorAll('.popover').forEach(p => p.style.display = 'none');
      if (!isVisible) {
        pop.style.display = 'block';
        if (onShow) onShow();
      }
    });

    document.addEventListener('click', () => {
      pop.style.display = 'none';
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
  }

  async function obsConnect() {
    const address = $('#obs-address').value.trim();
    const port = $('#obs-port').value.trim();
    const password = $('#obs-password').value.trim();
    const status = $('#obs-status');

    localStorage.setItem('bb_obsAddress', address);
    localStorage.setItem('bb_obsPort', port);
    secretSet('bb_obsPassword', password);

    try {
      status.textContent = "CONNECTING...";
      if (!state.obs) {
        const obsModule = await import('https://cdn.jsdelivr.net/npm/obs-websocket-js@5.0.5/+esm');
        state.obs = new obsModule.default();
      }
      await state.obs.connect(`ws://${address}:${port}`, password);
      state.obsConnected = true;
      status.textContent = "CONNECTED";
      status.style.color = "cyan";
      $('#btn-obs-connect').textContent = "DISCONNECT";
      state.obs.on('ConnectionClosed', () => {
        state.obsConnected = false;
        status.textContent = "DISCONNECTED";
        status.style.color = "inherit";
        $('#btn-obs-connect').textContent = "CONNECT";
      });
    } catch (error) {
      console.error("OBS Connection Error:", error);
      status.textContent = "ERROR: " + error.message;
      status.style.color = "var(--danger)";
    }
  }

  async function switchToObsScene(sceneName) {
    if (!state.obsConnected || !state.obs) return;
    try {
      await state.obs.call('SetCurrentProgramScene', { sceneName });
    } catch (error) {
      console.error("OBS Scene Switch Error:", error);
    }
  }

  function twitchConnect() {
    if (state.twitchConnected && state.twitchWS) {
      state.twitchWS.close();
      return;
    }
    const channel = $('#twitch-channel').value.toLowerCase();
    const token = $('#twitch-token').value;
    const status = $('#twitch-status');
    localStorage.setItem('bb_twitchChannel', channel);
    secretSet('bb_twitchToken', token);

    if (!token) {
      status.textContent = "NEED TOKEN";
      return;
    }

    status.textContent = "CONNECTING...";
    try {
        const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        state.twitchWS = ws;
        ws.onopen = () => {
          ws.send(`PASS ${token.startsWith('oauth:') ? token : 'oauth:' + token}`);
          ws.send(`NICK bus_broadcaster`);
          ws.send(`CAP REQ :twitch.tv/tags twitch.tv/commands`);
          ws.send(`JOIN #${channel}`);
        };
        ws.onmessage = (event) => {
          const frames = event.data.split('\r\n');
          frames.forEach(frame => {
            if (!frame) return;
            if (frame.startsWith('PING')) {
              ws.send('PONG :tmi.twitch.tv');
              return;
            }
            if (frame.includes(' :End of /NAMES list')) {
              state.twitchConnected = true;
              status.textContent = "CONNECTED";
              status.style.color = "#9b59b6";
              $('#btn-twitch-connect').textContent = "DISCONNECT";
              addMessage("System", `Twitch Uplink established to #${channel}`, true);
            }
            if (frame.includes('PRIVMSG')) parseTwitchMessage(frame);
          });
        };
        ws.onclose = () => {
          state.twitchConnected = false;
          status.textContent = "DISCONNECTED";
          status.style.color = "inherit";
          $('#btn-twitch-connect').textContent = "CONNECT CHAT";
          addMessage("System", `Twitch Uplink terminated.`, true);
        };
    } catch(e) { status.textContent = "ERROR"; }
  }

  function parseTwitchMessage(frame) {
    const parts = frame.split(' ');
    let tags = {};
    if (frame.startsWith('@')) {
      const tagString = parts[0].substring(1);
      tagString.split(';').forEach(t => {
        const [k, v] = t.split('=');
        tags[k] = v;
      });
    }
    const username = tags['display-name'] || frame.split('!')[0].split(':').pop();
    const messageContent = frame.split('PRIVMSG')[1].split(' :').slice(1).join(' :');
    const color = tags['color'] || '#9b59b6';
    addTwitchChatMessage(username, messageContent, color, tags['badges'] || "");
  }

  function addTwitchChatMessage(user, text, color, badges) {
    const msg = {
      id: Math.random().toString(36).substr(2, 9),
      character: user,
      text: text,
      timestamp: new Date(),
      isTwitch: true,
      color: color,
      isSub: badges.includes('subscriber') || badges.includes('founder'),
      isVIP: badges.includes('vip')
    };
    state.messages.push(msg);
    renderTwitchChatMessage(msg);
  }

  function renderTwitchChatMessage(msg) {
    const container = $('#chat-scroll');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'msg msg-twitch';
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-name" style="color:${safeColor(msg.color)}">👁 ${escapeHtml(msg.character.toUpperCase())}</span>
        <span>${msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="msg-text">${escapeHtml(msg.text)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function addMessage(char, text, isInternal) {
    const msg = {
      id: Math.random().toString(36).substr(2, 9),
      character: char,
      text: text,
      timestamp: new Date(),
      isInternal: isInternal
    };
    if (isInternal) {
      state.internalMessages.push(msg);
      renderInternalMessage(msg);
    } else {
      state.messages.push(msg);
      renderChatMessage(msg);
    }
  }

  function renderChatMessage(msg) {
    const container = $('#chat-scroll');
    if (!container) return;
    const char = characters.find(c => c.name === msg.character) || { color: '#8b8b8b' };
    if (msg.character === "Kobold") char.color = "var(--kobold)";
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-name" style="color:${char.color}">${escapeHtml(msg.character.toUpperCase())}</span>
        <span>${msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="msg-text">${escapeHtml(msg.text)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function renderInternalMessage(msg) {
    const container = $('#internal-scroll');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'msg msg-internal';
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-name" style="color:var(--internal)">${escapeHtml(msg.character.toUpperCase())}</span>
        <span>${msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="msg-text">${escapeHtml(msg.text)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    
    const mainChat = $('#chat-scroll');
    if (mainChat) {
        const mainDiv = document.createElement('div');
        mainDiv.className = 'msg msg-internal';
        mainDiv.innerHTML = div.innerHTML;
        mainChat.appendChild(mainDiv);
        mainChat.scrollTop = mainChat.scrollHeight;
    }
  }

  function renderActivityGrid() {
    const grid = $('#activity-grid');
    if (!grid) return;
    grid.innerHTML = '';
    grid.appendChild(createCard("DIAGNOSTICS", "System", "statusScreen"));
    characters.forEach(char => grid.appendChild(createCard(char.type.toUpperCase(), char.name, char.type, char.color, char.sprite)));
    state.cameraStations.forEach(cam => grid.appendChild(createCard(`CAM · ${cam.toUpperCase()}`, "System", "camera", "rgba(255,255,255,0.4)")));
  }

  function createCard(label, char, type, color = "rgba(255,255,255,0.4)", sprite = null) {
    const div = document.createElement('div');
    div.className = 'activity-card';
    div.innerHTML = `
      <div class="card-header">
        <div class="card-dot" style="background:${color}"></div>
        <div class="card-char" style="color:${color}">${char.toUpperCase()}</div>
        <div class="card-label">· ${label}</div>
      </div>
      <div class="card-content" style="display:flex; flex-direction:row; height:100%; width:100%; overflow:hidden;">
        ${sprite ? `<img src="./images/SVG/${sprite}" style="height:100%; object-fit:contain; opacity:0.8; margin-right:8px;" />` : ''}
        <div style="flex:1; position:relative;">${renderCardInnerContent(type)}</div>
      </div>
    `;
    return div;
  }

  function renderCardInnerContent(type) {
    if (type === 'statusScreen') return renderDiagnosticContent();
    if (type === 'camera') return '<div class="camera-static"></div>';
    if (type === 'scheduling') {
      return `<div style="display:grid; grid-template-columns:30px 1fr 1fr; gap:1px; background:rgba(255,255,255,0.1); height:100%; font-size:7px; color:rgba(255,255,255,0.6)">
                <div style="background:#111; padding:2px">A1</div><div style="background:#111; padding:2px">FREQ</div><div style="background:#111; padding:2px">STATUS</div>
                <div style="background:#0a0a0a; padding:2px">1</div><div style="background:#0a0a0a; padding:2px">104.5</div><div style="background:#0a0a0a; padding:2px; color:var(--good)">OK</div>
                <div style="background:#0a0a0a; padding:2px">2</div><div style="background:#0a0a0a; padding:2px">98.1</div><div style="background:#0a0a0a; padding:2px; color:var(--danger)">WARN</div>
              </div>`;
    }
    return `<div style="display:flex; flex-direction:column; justify-content:center; height:100%; opacity:0.5; font-size:8px;"><div>SYSTEM STATUS: NOMINAL</div><div class="camera-static" style="opacity:0.2"></div></div>`;
  }

  function renderDiagnosticContent() {
    return `<div class="diag-container">
              ${renderDiagRow("HEAT", state.heat, "var(--danger)")}
              ${renderDiagRow("SIGNAL", state.strength, "var(--good)")}
              ${renderDiagRow("FUEL", state.diesel, "var(--accent)")}
              ${renderDiagRow("PARTS", state.battery, "cyan")}
            </div>`;
  }

  function renderDiagRow(label, val, color) {
    return `<div class="diag-row">
              <div class="diag-label" style="color:${color}">${label}</div>
              <div class="diag-bar-bg"><div class="diag-bar-fill" style="width:${val}%; background:${color}"></div></div>
              <div style="width:25px; text-align:right; opacity:0.4">${Math.floor(val)}%</div>
            </div>`;
  }

  function renderOverview() {
    const container = $('#overview-content');
    if (!container) return;
    container.innerHTML = state.cameraStations.map(cam => `<div class="popover-item"><div class="dot"></div><span>CAM: ${cam.toUpperCase()}</span></div>`).join('');
  }

  function renderSchedule() {
    const schedule = [["00:00–05:00", "DEAD AIR"], ["05:00–07:00", "WARMUP"], ["21:00–00:00", "KOBOLD"]];
    const container = $('#schedule-content');
    if (container) container.innerHTML = schedule.map(s => `<div class="popover-item" style="gap:15px"><span style="opacity:0.4; width:80px">${s[0]}</span><span>${s[1]}</span></div>`).join('');
  }

  function renderInventory() {
    const container = $('#inventory-content');
    if (container) container.innerHTML = state.koboldInventory.map(item => `<div class="popover-item"><span>${item}</span></div>`).join('');
  }

  function simulateChat() { if (Math.random() > 0.6) { const char = characters[Math.floor(Math.random() * characters.length)]; addMessage(char.name, "Scanning bands...", Math.random() > 0.5); } }
  function simulateSpeaker() { 
    const char = characters[Math.floor(Math.random() * characters.length)];
    state.currentSpeaker = char.name;
    if (state.broadcasting) switchToObsScene(state.obsScenes[char.name]);
    setTimeout(() => { state.currentSpeaker = null; }, 7000);
  }

  function resize() {
    Object.values(canvases).forEach(canvas => {
      if (!canvas) return;
      const r = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
    });
  }

  function draw(t) {
    const dt = state.tLast ? Math.min(0.05, (t - state.tLast) / 1000) : 0;
    state.tLast = t;
    if (!state.gameOver) {
      if (state.broadcasting) { state.heat += 2.0 * dt; state.battery -= 1.0 * dt; if (state.heat >= 100) state.gameOver = true; }
      else { state.heat = Math.max(0, state.heat - 1.5 * dt); }
      const diag = $('.diag-container');
      if (diag) diag.innerHTML = renderDiagnosticContent();
    }
    const ctxL = ctxs.live;
    if (!ctxL) return;
    const wL = canvases.live.width / (window.devicePixelRatio || 1);
    const hL = canvases.live.height / (window.devicePixelRatio || 1);
    ctxL.fillStyle = '#05060a'; ctxL.fillRect(0, 0, wL, hL);
    if (state.currentSpeaker && state.assets.images[state.currentSpeaker]) {
      const img = state.assets.images[state.currentSpeaker];
      const aspect = img.width / img.height;
      const drawH = hL * 0.8; const drawW = drawH * aspect;
      ctxL.drawImage(img, (wL - drawW)/2, (hL - drawH)/2, drawW, drawH);
    } else {
        const tp = $('#test-pattern');
        if (tp) tp.style.display = 'flex';
    }
    if (state.assets.images.ui_live) ctxL.drawImage(state.assets.images.ui_live, 0, 0, wL, hL);
    requestAnimationFrame(draw);
  }

  function saveGameState() {
    localStorage.setItem('bb_save', encryptStr(JSON.stringify({
      timestamp: Date.now(), heat: state.heat, battery: state.battery, diesel: state.diesel,
      money: state.money, viewership: state.viewership, broadcasting: state.broadcasting,
      gameOver: state.gameOver, messages: state.messages, internalMessages: state.internalMessages
    })));
  }

  function loadGameState() {
    try {
      const dataStr = localStorage.getItem('bb_save');
      if (!dataStr) return false;
      const data = JSON.parse(decryptStr(dataStr));
      const dt = (Date.now() - data.timestamp) / 1000;
      Object.assign(state, data);
      state.heat = Math.min(100, state.heat + (state.broadcasting ? 2 * dt : -1.5 * dt));
      state.messages.forEach(m => m.timestamp = new Date(m.timestamp));
      state.internalMessages.forEach(m => m.timestamp = new Date(m.timestamp));
      renderActivityGrid(); 
      return true;
    } catch(e) { return false; }
  }

  init();
})();
