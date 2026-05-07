const colors = ["#2f7d72", "#d96b6b", "#725ac1", "#c3832e", "#3176a3", "#7b8b3a"];
const params = new URLSearchParams(location.search);
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const isLocalDev = ["localhost", "127.0.0.1", ""].includes(location.hostname);
const isGravityFrame = window.parent !== window;
const defaultAvatar =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect width='80' height='80' fill='%23eef5f1'/%3E%3Ccircle cx='40' cy='30' r='15' fill='%232f7d72'/%3E%3Cpath d='M15 76c4-18 16-28 25-28s21 10 25 28' fill='%232f7d72'/%3E%3C/svg%3E";

let roomId = params.get("room") || params.get("roomId") || makeRoomId();
let player;
let socket;
let playerReady = false;
let suppressEvents = false;
let transport = "pending";
let gravityRoomReady = false;
let presenceTimer;
let currentState = { videoId: "", title: "", time: 0, playing: false };
let messages = [];
let members = new Map();
let seenGravityMessages = new Set();
let you = JSON.parse(localStorage.getItem("gravity-watch-profile") || "null") || {
  id: crypto.randomUUID(),
  name: `guest-${Math.floor(Math.random() * 900 + 100)}`,
  color: colors[Math.floor(Math.random() * colors.length)],
  avatar: "",
  gravityUserId: "",
};

const gravity = createGravityBridge();

const elements = {
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  connectionStatus: document.querySelector("#connectionStatus"),
  displayName: document.querySelector("#displayName"),
  emptyState: document.querySelector("#emptyState"),
  gravityStatus: document.querySelector("#gravityStatus"),
  memberCount: document.querySelector("#memberCount"),
  members: document.querySelector("#members"),
  messages: document.querySelector("#messages"),
  pauseButton: document.querySelector("#pauseButton"),
  playButton: document.querySelector("#playButton"),
  poster: document.querySelector("#poster"),
  profileAvatar: document.querySelector("#profileAvatar"),
  roomLabel: document.querySelector("#roomLabel"),
  saveName: document.querySelector("#saveName"),
  shareRoom: document.querySelector("#shareRoom"),
  syncButton: document.querySelector("#syncButton"),
  toast: document.querySelector("#toast"),
  videoForm: document.querySelector("#videoForm"),
  videoTitle: document.querySelector("#videoTitle"),
  videoUrl: document.querySelector("#videoUrl"),
};

if (!params.has("room") && !params.has("roomId") && window.parent === window) {
  history.replaceState({}, "", `?room=${encodeURIComponent(roomId)}`);
}

applyProfileFromUrl();
renderProfile();
renderRoomLabel();
start();

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    height: "100%",
    width: "100%",
    playerVars: {
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        playerReady = true;
        applyState(currentState, false);
      },
      onStateChange: onPlayerStateChange,
    },
  });
};

elements.videoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const videoId = extractYouTubeId(elements.videoUrl.value);
  if (!videoId) {
    showToast("YouTube URLを確認してください");
    return;
  }
  const title = await resolveTitle(videoId);
  sendRoomEvent({ type: "loadVideo", state: { videoId, title, time: 0, playing: false } });
  elements.videoUrl.value = "";
});

elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text) return;
  sendRoomEvent({ type: "chat", message: makeChat(text) });
  elements.chatInput.value = "";
});

elements.playButton.addEventListener("click", () => {
  if (!playerReady || !currentState.videoId) return;
  player.playVideo();
  sendRoomEvent({
    type: "playerAction",
    state: { ...currentState, time: player.getCurrentTime(), playing: true },
  });
});

elements.pauseButton.addEventListener("click", () => {
  if (!playerReady || !currentState.videoId) return;
  player.pauseVideo();
  sendRoomEvent({
    type: "playerAction",
    state: { ...currentState, time: player.getCurrentTime(), playing: false },
  });
});

elements.syncButton.addEventListener("click", () => {
  if (!playerReady || !currentState.videoId) return;
  sendRoomEvent({
    type: "seek",
    state: { ...currentState, time: player.getCurrentTime(), playing: currentState.playing },
  });
});

elements.saveName.addEventListener("click", () => {
  const nextName = elements.displayName.value.trim().slice(0, 24);
  if (!nextName) return;
  you = { ...you, name: nextName };
  localStorage.setItem("gravity-watch-profile", JSON.stringify(you));
  renderProfile();
  announcePresence();
  if (transport === "websocket") connectWebSocket(true);
  showToast("表示名を更新しました");
});

elements.shareRoom.addEventListener("click", async () => {
  if (transport === "gravity-unavailable") {
    showToast("Gravity側のURL許可が必要です");
    return;
  }

  if (transport === "gravity") {
    await ensureGravityRoom(true);
    if (gravityRoomReady) return;
  }

  const url = location.href;
  const text = `Gravity Watch Partyで一緒に観よう: ${url}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "Gravity Watch Party", text, url });
    } else {
      await navigator.clipboard.writeText(text);
      showToast("Gravityに貼れる招待文をコピーしました");
    }
  } catch {
    await navigator.clipboard.writeText(text);
    showToast("招待文をコピーしました");
  }
});

async function start() {
  addOrRefreshMember(you);
  renderRoster();
  const gravityReady = await setupGravity();
  if (gravityReady) return;

  if (isLocalDev) {
    connectWebSocket();
    return;
  }

  transport = "gravity-unavailable";
  if (isGravityFrame) {
    setConnection("連携不可", false);
    elements.gravityStatus.textContent = "Gravityがこの配信URLを許可していません";
    showToast("Gravity連携が許可されていません");
  } else {
    setConnection("Gravity外", false);
    elements.gravityStatus.textContent = "Gravity内で開くとユーザー情報を使えます";
  }
}

async function setupGravity() {
  if (!isGravityFrame) return false;

  try {
    setConnection("Gravity確認中", false);
    const userResult = await gravity.api("AgentSDK.user.getMyUserInfo", {}, 1800);
    const profile = normalizeGravityUser(userResult);
    if (profile) {
      you = {
        ...you,
        name: profile.name || you.name,
        avatar: profile.portrait || you.avatar,
        gravityUserId: String(profile.user_id || profile.uid || you.gravityUserId || ""),
      };
      localStorage.setItem("gravity-watch-profile", JSON.stringify(you));
      renderProfile();
      elements.gravityStatus.textContent = "Gravityユーザー情報を使用中";
    }

    transport = "gravity";
    setConnection("Gravity接続", true);
    const gravityRoomId = params.get("room_id") || params.get("roomid") || params.get("roomId") || "";
    if (gravityRoomId) {
      roomId = gravityRoomId;
      await gravity.room("join_room", { room_id: roomId }, 2500).catch(() => {});
      await enableGravityRoom();
    } else {
      renderRoomLabel("Gravityルーム未作成");
      showToast("共有ボタンでGravityルームを作成できます");
    }
    return true;
  } catch (error) {
    console.warn("Gravity SDK bridge is unavailable", error);
    return false;
  }
}

async function ensureGravityRoom(showInvite) {
  if (gravityRoomReady) {
    if (showInvite) showToast("Gravityのルーム招待を開きました");
    return;
  }

  try {
    const result = await gravity.room(
      "create_room",
      { room_type: "aitools_game_room", max_players: 20, maxplayers: 20, room_permission: 0, permission: 0 },
      3000,
    );
    const roomData = result?.data || result || {};
    const createdRoomId = roomData.room_id || roomData.roomId || "";
    if (createdRoomId) roomId = createdRoomId;
    await enableGravityRoom();
    broadcastCurrentState();
    if (showInvite) showToast("Gravityルームを作成しました");
  } catch {
    showToast("Gravityルームを作成できませんでした");
  }
}

async function enableGravityRoom() {
  gravityRoomReady = true;
  renderRoomLabel("Gravityルーム");
  gravity.onRoomMessage(handleGravityMessage);
  announcePresence();
  clearInterval(presenceTimer);
  presenceTimer = setInterval(announcePresence, 12000);
}

function connectWebSocket(rejoin = false) {
  transport = "websocket";
  if (socket) socket.close();
  socket = new WebSocket(wsUrl);
  setConnection("接続中", false);

  socket.addEventListener("open", () => {
    setConnection("オンライン", true);
    socket.send(
      JSON.stringify({
        type: "join",
        roomId,
        name: you.name,
        color: you.color,
        avatar: you.avatar,
        gravityUserId: you.gravityUserId,
      }),
    );
    if (rejoin) showToast("ルームに再接続しました");
  });

  socket.addEventListener("close", () => {
    if (transport !== "websocket") return;
    setConnection("再接続中", false);
    setTimeout(() => connectWebSocket(), 1200);
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "joined") {
      currentState = message.state;
      messages = message.messages || [];
      renderMessages(messages);
      renderRoster(message.roster || []);
      applyState(message.state, true);
      return;
    }

    if (message.type === "roster") renderRoster(message.roster || []);
    if (message.type === "chat") appendMessage(message.message);

    if (["videoLoaded", "playerAction", "seek"].includes(message.type)) {
      currentState = message.state;
      applyState(message.state, message.type !== "videoLoaded");
      if (message.actor) showToast(`${message.actor} が同期しました`);
    }
  });
}

function sendRoomEvent(payload) {
  if (transport === "gravity") {
    if (!gravityRoomReady) {
      showToast("先に共有ボタンでGravityルームを作成してください");
      handleRoomEvent({ ...payload, actor: you.name });
      return;
    }
    const envelope = {
      app: "gravity-watch-party",
      id: crypto.randomUUID(),
      member: publicMember(you),
      sentAt: Date.now(),
      payload,
    };
    handleGravityEnvelope(envelope);
    sendGravityEnvelope(envelope).catch(() => {
      showToast("Gravityルームへの送信に失敗しました");
    });
    return;
  }

  if (socket?.readyState !== WebSocket.OPEN) return;
  if (payload.type === "loadVideo") {
    socket.send(JSON.stringify({ type: "loadVideo", ...payload.state }));
  } else if (payload.type === "playerAction") {
    socket.send(
      JSON.stringify({
        type: "playerAction",
        action: payload.state.playing ? "play" : "pause",
        time: payload.state.time,
      }),
    );
  } else if (payload.type === "seek") {
    socket.send(JSON.stringify({ type: "seek", time: payload.state.time }));
  } else if (payload.type === "chat") {
    socket.send(JSON.stringify({ type: "chat", text: payload.message.text }));
  }
}

function broadcastCurrentState() {
  announcePresence();
  if (currentState.videoId) {
    sendRoomEvent({ type: "stateSnapshot", state: currentState });
  }
}

function announcePresence() {
  addOrRefreshMember(you);
  renderRoster();
  if (transport !== "gravity" || !gravityRoomReady) return;
  const envelope = {
    app: "gravity-watch-party",
    id: crypto.randomUUID(),
    member: publicMember(you),
    sentAt: Date.now(),
    payload: { type: "presence" },
  };
  sendGravityEnvelope(envelope).catch(() => {});
}

async function sendGravityEnvelope(envelope) {
  const message = JSON.stringify(envelope);
  const payload = {
    room_id: roomId,
    msg_data: message,
    message,
  };
  try {
    return await gravity.room("send_msg", payload, 1800);
  } catch (error) {
    return gravity.room("send_message", payload, 1800);
  }
}

function handleGravityMessage(event) {
  const envelope = parseGravityEnvelope(event);
  if (!envelope) return;
  handleGravityEnvelope(envelope);
}

function handleGravityEnvelope(envelope) {
  if (seenGravityMessages.has(envelope.id)) return;
  seenGravityMessages.add(envelope.id);
  if (envelope.member) addOrRefreshMember(envelope.member);
  renderRoster();
  handleRoomEvent({ ...envelope.payload, actor: envelope.member?.name || "member" });
}

function handleRoomEvent(event) {
  if (event.type === "presence") return;
  if (event.type === "loadVideo" || event.type === "stateSnapshot") {
    currentState = { ...event.state, updatedAt: Date.now() };
    applyState(currentState, event.type === "stateSnapshot");
    return;
  }
  if (event.type === "playerAction" || event.type === "seek") {
    currentState = { ...event.state, updatedAt: Date.now() };
    applyState(currentState, true);
    if (event.actor) showToast(`${event.actor} が同期しました`);
    return;
  }
  if (event.type === "chat") appendMessage(event.message);
}

function applyState(state, preservePlayback) {
  currentState = state;
  elements.videoTitle.textContent = state.title || "未選択";
  elements.emptyState.classList.toggle("hidden", Boolean(state.videoId));

  if (state.videoId) {
    elements.poster.src = `https://img.youtube.com/vi/${state.videoId}/maxresdefault.jpg`;
  }

  if (!playerReady || !state.videoId) return;

  suppressEvents = true;
  const loadedVideo = player.getVideoData?.().video_id;
  if (loadedVideo !== state.videoId) {
    player.cueVideoById({ videoId: state.videoId, startSeconds: state.time || 0 });
  } else if (Math.abs(player.getCurrentTime() - state.time) > 1.5) {
    player.seekTo(state.time || 0, true);
  }

  if (preservePlayback) {
    if (state.playing) player.playVideo();
    else player.pauseVideo();
  }

  window.setTimeout(() => {
    suppressEvents = false;
  }, 700);
}

function onPlayerStateChange(event) {
  if (suppressEvents || !currentState.videoId) return;
  if (event.data === YT.PlayerState.PLAYING) {
    sendRoomEvent({
      type: "playerAction",
      state: { ...currentState, time: player.getCurrentTime(), playing: true },
    });
  }
  if (event.data === YT.PlayerState.PAUSED) {
    sendRoomEvent({
      type: "playerAction",
      state: { ...currentState, time: player.getCurrentTime(), playing: false },
    });
  }
}

function createGravityBridge() {
  const pendingApi = new Map();
  const pendingRoom = new Map();
  let roomHandler = () => {};

  window.addEventListener("message", (event) => {
    const data = event.data || {};

    const apiId = data.requestId || data.id;
    if (data.type === "API_CALLBACK" && apiId && pendingApi.has(apiId)) {
      const entry = pendingApi.get(apiId);
      pendingApi.delete(apiId);
      clearTimeout(entry.timer);
      data.error ? entry.reject(data.error) : entry.resolve(data.payload);
    }

    const roomId = data.actionId || data.actionld;
    if ((data.type === "gravityroomresponse" || data.type === "gravity_room_response") && roomId && pendingRoom.has(roomId)) {
      const entry = pendingRoom.get(roomId);
      pendingRoom.delete(roomId);
      clearTimeout(entry.timer);
      const result = data.result || {};
      if (result.errno !== undefined && result.errno !== 0) {
        entry.reject(new Error(result.errmsg || `Gravity room error ${result.errno}`));
      } else {
        entry.resolve(result);
      }
    }

    if (data.type === "gravityroomevent" || data.type === "gravity_room_event") {
      roomHandler(data.payload || data);
    }

    if (data.type === "EVENT_CALLBACK" && data.action === "AgentSDK.room.receiveMessage") {
      roomHandler(data.payload);
    }
  });

  return {
    api(action, params = {}, timeout = 1500) {
      if (!isGravityFrame) return Promise.reject(new Error("Gravity loader is not available"));
      const requestId = `req_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingApi.delete(requestId);
          reject(new Error("Gravity API timeout"));
        }, timeout);
        pendingApi.set(requestId, { resolve, reject, timer });
        window.top.postMessage({ type: "API", action, requestId, params }, "*");
      });
    },
    room(action, params = {}, timeout = 1500) {
      if (!isGravityFrame) return Promise.reject(new Error("Gravity loader is not available"));
      const actionId = `${action}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRoom.delete(actionId);
          reject(new Error("Gravity room timeout"));
        }, timeout);
        pendingRoom.set(actionId, { resolve, reject, timer });
        window.parent.postMessage({ action, actionId, actionld: actionId, ...params }, "*");
      });
    },
    onRoomMessage(handler) {
      roomHandler = handler;
    },
  };
}

function parseGravityEnvelope(event) {
  const raw =
    event?.data?.msg_data ||
    event?.data?.pkg_data?.msg_data ||
    event?.pkg_data?.msg_data ||
    event?.message ||
    event;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value?.app === "gravity-watch-party" ? value : null;
  } catch {
    return null;
  }
}

function addOrRefreshMember(member) {
  const id = member.gravityUserId || member.id || member.name;
  members.set(id, { ...publicMember(member), lastSeen: Date.now() });
}

function publicMember(member) {
  return {
    id: member.id || member.gravityUserId || member.name,
    name: member.name || "guest",
    color: member.color || colors[0],
    avatar: member.avatar || "",
    gravityUserId: member.gravityUserId || "",
  };
}

function normalizeGravityUser(value) {
  const user = value?.data || value?.payload?.data || value?.payload || value;
  if (!user || typeof user !== "object") return null;
  return {
    name: user.name || user.nickname || user.user_name || user.username || "",
    portrait: user.portrait || user.avatar || user.icon || user.head_img || user.headimgurl || user.profile_image || "",
    user_id: user.user_id || user.uid || user.id || "",
  };
}

function applyProfileFromUrl() {
  const name = params.get("username") || params.get("name") || params.get("nickname") || params.get("userName");
  const rawAvatar =
    params.get("portrait") ||
    params.get("avatar") ||
    params.get("icon") ||
    params.get("head_img") ||
    params.get("headimgurl");
  const avatar = rawAvatar ? decodeURIComponent(rawAvatar) : "";
  const gravityUserId = params.get("user_id") || params.get("uid") || params.get("userId");

  if (!name && !avatar && !gravityUserId) return;
  you = {
    ...you,
    name: name || you.name,
    avatar: avatar || you.avatar,
    gravityUserId: gravityUserId || you.gravityUserId,
  };
  localStorage.setItem("gravity-watch-profile", JSON.stringify(you));
}

function renderProfile() {
  elements.displayName.value = you.name;
  elements.profileAvatar.src = you.avatar || defaultAvatar;
}

function renderRoster(roster) {
  const list = roster || Array.from(members.values()).filter((member) => Date.now() - member.lastSeen < 45000);
  elements.memberCount.textContent = String(list.length);
  elements.members.replaceChildren(
    ...list.map((member) => {
      const node = document.createElement("div");
      node.className = "member";
      node.innerHTML = `<i></i><span></span>`;
      const icon = node.querySelector("i");
      if (member.avatar) {
        icon.style.backgroundImage = `url("${member.avatar}")`;
        icon.style.backgroundColor = "transparent";
      } else {
        icon.style.backgroundColor = member.color;
      }
      node.querySelector("span").textContent = member.name;
      return node;
    }),
  );
}

function renderMessages(nextMessages) {
  messages = [];
  elements.messages.replaceChildren();
  nextMessages.forEach(appendMessage);
}

function appendMessage(message) {
  if (!message) return;
  messages.push(message);
  messages = messages.slice(-80);
  const node = document.createElement("article");
  node.className = "message";
  const name = document.createElement("strong");
  name.textContent = message.name;
  name.style.color = message.color;
  const text = document.createElement("p");
  text.textContent = message.text;
  node.append(name, text);
  elements.messages.append(node);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function makeChat(text) {
  return {
    id: crypto.randomUUID(),
    text,
    name: you.name,
    color: you.color,
    avatar: you.avatar,
    gravityUserId: you.gravityUserId,
    at: Date.now(),
  };
}

function extractYouTubeId(value) {
  try {
    const url = new URL(value.trim());
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1).split("/")[0];
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const shortsMatch = url.pathname.match(/\/shorts\/([^/?]+)/);
    if (shortsMatch) return shortsMatch[1];
    const embedMatch = url.pathname.match(/\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];
  } catch {
    if (/^[a-zA-Z0-9_-]{11}$/.test(value.trim())) return value.trim();
  }
  return "";
}

async function resolveTitle(videoId) {
  try {
    const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
    const data = await response.json();
    return data.title || "YouTube video";
  } catch {
    return "YouTube video";
  }
}

function renderRoomLabel(prefix = transport === "gravity" ? "Gravity" : "local") {
  elements.roomLabel.textContent = `${prefix}: ${roomId}`;
}

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function setConnection(text, online) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.classList.toggle("online", online);
}

function showToast(text) {
  elements.toast.textContent = text;
  elements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}
