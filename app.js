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
let isHost = false;
let presenceTimer;
let currentState = { videoId: "", title: "", time: 0, playing: false };
let messages = [];
let members = new Map();
let seenGravityMessages = new Set();
let profileLoadedFromUrl = false;
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
  createPrivateRoom: document.querySelector("#createPrivateRoom"),
  createPublicRoom: document.querySelector("#createPublicRoom"),
  currentRoomId: document.querySelector("#currentRoomId"),
  displayName: document.querySelector("#displayName"),
  emptyState: document.querySelector("#emptyState"),
  gravityStatus: document.querySelector("#gravityStatus"),
  hostBadge: document.querySelector("#hostBadge"),
  joinRoomButton: document.querySelector("#joinRoomButton"),
  joinRoomId: document.querySelector("#joinRoomId"),
  leaveRoom: document.querySelector("#leaveRoom"),
  lobbyScreen: document.querySelector("#lobbyScreen"),
  memberCount: document.querySelector("#memberCount"),
  members: document.querySelector("#members"),
  messages: document.querySelector("#messages"),
  pauseButton: document.querySelector("#pauseButton"),
  playButton: document.querySelector("#playButton"),
  poster: document.querySelector("#poster"),
  profileAvatar: document.querySelector("#profileAvatar"),
  roomLabel: document.querySelector("#roomLabel"),
  roomScreen: document.querySelector("#roomScreen"),
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

elements.createPublicRoom.addEventListener("click", () => {
  ensureGravityRoom(true, 0);
});

elements.createPrivateRoom.addEventListener("click", () => {
  ensureGravityRoom(true, 1);
});

elements.joinRoomButton.addEventListener("click", () => {
  const id = elements.joinRoomId.value.trim();
  if (id) joinGravityRoom(id);
});

elements.joinRoomId.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    elements.joinRoomButton.click();
  }
});

elements.leaveRoom.addEventListener("click", leaveGravityRoom);

elements.shareRoom.addEventListener("click", async () => {
  if (transport === "gravity" || transport === "gravity-unavailable") {
    transport = "gravity";
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
    setConnection("Gravity待機", false);
    elements.gravityStatus.textContent = "共有ボタンでルーム作成を試せます";
    showLobby();
  } else {
    setConnection("Gravity外", false);
    elements.gravityStatus.textContent = "Gravity内で開くとユーザー情報を使えます";
    showLobby();
  }
}

async function setupGravity() {
  if (!isGravityFrame) return false;

  setConnection("Gravity確認中", false);

  try {
    await gravity.ready(1800).catch(() => {});
    if (!profileLoadedFromUrl) {
      const userResult = await gravity.api("AgentSDK.user.getMyUserInfo", {}, 1800);
      const profile = normalizeGravityUser(userResult);
      if (profile) {
        you = {
          ...you,
          name: profile.name || you.name,
          avatar: profile.portrait || you.avatar,
          gravityUserId: String(profile.user_id || you.gravityUserId || ""),
        };
        localStorage.setItem("gravity-watch-profile", JSON.stringify(you));
        renderProfile();
        elements.gravityStatus.textContent = "Gravityユーザー情報を使用中";
      }
    } else {
      elements.gravityStatus.textContent = "Gravityユーザー情報を使用中";
    }
  } catch (error) {
    console.warn("Gravity user bridge is unavailable; continuing with URL profile", error);
    if (profileLoadedFromUrl) {
      elements.gravityStatus.textContent = "Gravityユーザー情報を使用中";
    } else {
      elements.gravityStatus.textContent = "表示名を手動で設定できます";
    }
  }

  try {
    transport = "gravity";
    setConnection("Gravity接続", true);

    const gravityRoomId = params.get("room_id") || params.get("roomid") || params.get("roomId") || "";
    if (gravityRoomId) {
      await joinGravityRoom(gravityRoomId, { quiet: true });
    } else {
      renderRoomLabel("Gravityルーム未作成");
      showLobby();
    }
    return true;
  } catch (error) {
    console.warn("Gravity room bridge is unavailable", error);
    if (profileLoadedFromUrl) {
      you = {
        ...you,
        name: you.name,
      };
      elements.gravityStatus.textContent = "Gravityユーザー情報を使用中";
      transport = "gravity";
      setConnection("Gravity待機", false);
      renderRoomLabel("Gravityルーム未作成");
      showLobby();
      return true;
    }
    return false;
  }
}

async function ensureGravityRoom(showInvite, permission = 0) {
  if (gravityRoomReady) {
    if (showInvite) showToast("Gravityのルーム招待を開きました");
    return;
  }

  try {
    transport = "gravity";
    setConnection("作成中", false);
    showToast("ルームを作成中...");
    const result = await gravity.room(
      "create_room",
      { room_type: "aitools_game_room", max_players: 20, maxplayers: 20, room_permission: permission, permission },
      3000,
    );
    if (isErrorResult(result)) throw new Error(result.errmsg || `errno ${result.errno}`);
    const roomData = result?.data || result || {};
    const createdRoomId = roomData.room_id || roomData.roomId || "";
    if (!createdRoomId) throw new Error("room_id が返りませんでした");
    if (createdRoomId) roomId = createdRoomId;
    isHost = true;
    await enableGravityRoom();
    broadcastCurrentState();
    if (showInvite) showToast(`ルームを作成しました: ${roomId}`);
  } catch (error) {
    console.warn("Create room failed", error);
    showToast(`作成失敗: ${error.message || "通信エラー"}`);
    showLobby();
  }
}

async function joinGravityRoom(id, options = {}) {
  try {
    transport = "gravity";
    setConnection("参加中", false);
    roomId = id;
    const joinResult = await gravity.room("join_room", { room_id: roomId }, 3000);
    if (isErrorResult(joinResult)) throw new Error(joinResult.errmsg || `errno ${joinResult.errno}`);
    addUsersFromRoomResult(joinResult);
    isHost = false;
    await enableGravityRoom();
    sendRoomEvent({ type: "REQ_SYNC" });
    if (!options.quiet) showToast("ルームに参加しました");
  } catch (error) {
    console.warn("Join room failed", error);
    showToast("ルームに参加できませんでした");
    showLobby();
  }
}

async function enableGravityRoom() {
  gravityRoomReady = true;
  renderRoomLabel("Gravityルーム");
  showRoom();
  gravity.onRoomMessage(handleGravityMessage);
  addOrRefreshMember(you);
  renderRoster();
  announcePresence();
  clearInterval(presenceTimer);
  presenceTimer = setInterval(announcePresence, 12000);
}

async function leaveGravityRoom() {
  try {
    if (transport === "gravity") await gravity.room("exit_room", {}, 1200).catch(() => {});
  } finally {
    gravityRoomReady = false;
    isHost = false;
    roomId = params.get("room") || params.get("roomId") || makeRoomId();
    members.clear();
    messages = [];
    renderMessages(messages);
    addOrRefreshMember(you);
    renderRoster();
    showLobby();
    setConnection(isGravityFrame ? "Gravity待機" : "Gravity外", false);
  }
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
  if (envelope) {
    handleGravityEnvelope(envelope);
    return;
  }
  handleGravityPlatformEvent(event);
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
  if (event.type === "REQ_SYNC") {
    if (isHost) broadcastCurrentState();
    return;
  }
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

function handleGravityPlatformEvent(event) {
  const type = event?.type || "";
  const data = event?.data || {};

  if (type === "aitools_game_joinroom" || type === "aitoolsgamejoinroom") {
    addOrRefreshMember(memberFromGravityUser(data));
    renderRoster();
    return;
  }

  if (type === "aitools_game_exitroom" || type === "aitoolsgameexitroom") {
    const id = String(data.user_id || data.uid || data.id || data.user_name || data.name || "");
    if (id) members.delete(id);
    renderRoster();
  }
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
  let receiveRegistered = false;

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

  function sdk() {
    return window.AgentSDK;
  }

  async function waitForSdk(timeout = 1500) {
    if (sdk()) return sdk();
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (sdk()) return sdk();
    }
    throw new Error("AgentSDK timeout");
  }

  function registerDirectReceiver() {
    const api = sdk();
    if (receiveRegistered || !api?.room?.receiveMessage) return;
    receiveRegistered = true;
    api.room.receiveMessage((payload) => {
      roomHandler(payload);
    });
  }

  function withTimeout(promise, timeout, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeout)),
    ]);
  }

  function postRoom(action, params = {}, timeout = 1500) {
    const actionId = `${action}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRoom.delete(actionId);
        reject(new Error(`${action} bridge timeout`));
      }, timeout);
      pendingRoom.set(actionId, { resolve, reject, timer });
      window.parent.postMessage({ action, actionId, actionld: actionId, ...params }, "*");
    });
  }

  return {
    ready: waitForSdk,
    api(action, params = {}, timeout = 1500) {
      if (!isGravityFrame) return Promise.reject(new Error("Gravity loader is not available"));
      if (sdk()?.user?.getMyUserInfo && action === "AgentSDK.user.getMyUserInfo") {
        return sdk().user.getMyUserInfo(params);
      }
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
      const api = sdk();
      if (api?.room) {
        if (action === "create_room") {
          return withTimeout(
            api.room.create({
              max_players: params.max_players || params.maxplayers || 20,
              room_permission: params.room_permission ?? params.permission ?? 0,
            }),
            timeout,
            "create_room",
          ).catch((error) => {
            console.warn("Direct create_room failed, falling back to bridge", error);
            return postRoom(action, params, timeout);
          });
        }
        if (action === "join_room") {
          return withTimeout(api.room.join({ room_id: params.room_id }), timeout, "join_room").catch((error) => {
            console.warn("Direct join_room failed, falling back to bridge", error);
            return postRoom(action, params, timeout);
          });
        }
        if (action === "send_msg" || action === "send_message") {
          return withTimeout(api.room.sendMessage({ message: params.message || params.msg_data || "" }), timeout, "send_msg").catch((error) => {
            console.warn("Direct send_msg failed, falling back to bridge", error);
            return postRoom(action, params, timeout);
          });
        }
        if (action === "get_public_rooms") {
          return withTimeout(api.room.getPublicRoomList(), timeout, "get_public_rooms").catch((error) => {
            console.warn("Direct get_public_rooms failed, falling back to bridge", error);
            return postRoom(action, params, timeout);
          });
        }
        if (action === "exit_room" && api.room.exit) {
          return withTimeout(api.room.exit(), timeout, "exit_room").catch((error) => {
            console.warn("Direct exit_room failed, falling back to bridge", error);
            return postRoom(action, params, timeout);
          });
        }
      }
      return postRoom(action, params, timeout);
    },
    onRoomMessage(handler) {
      roomHandler = handler;
      registerDirectReceiver();
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

function addUsersFromRoomResult(result) {
  const data = result?.data || result || {};
  const userList = data.user_list || data.userList || data.users || [];
  if (!Array.isArray(userList)) return;
  userList.forEach((user) => addOrRefreshMember(memberFromGravityUser(user)));
  renderRoster();
}

function memberFromGravityUser(user) {
  return {
    id: String(user.user_id || user.uid || user.id || user.user_name || user.name || crypto.randomUUID()),
    name: user.name || user.nickname || user.user_name || user.username || "guest",
    color: colors[Math.floor(Math.random() * colors.length)],
    avatar: user.portrait || user.avatar || user.icon || user.head_img || user.headimgurl || user.profile_image || "",
    gravityUserId: String(user.user_id || user.uid || user.id || ""),
  };
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

function isErrorResult(result) {
  return result && typeof result === "object" && result.errno !== undefined && Number(result.errno) !== 0;
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
  profileLoadedFromUrl = true;
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

function showLobby() {
  elements.lobbyScreen.classList.add("active");
  elements.roomScreen.classList.remove("active");
}

function showRoom() {
  elements.lobbyScreen.classList.remove("active");
  elements.roomScreen.classList.add("active");
  elements.currentRoomId.textContent = roomId || "----";
  elements.joinRoomId.value = "";
  elements.hostBadge.classList.toggle("show", isHost);
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
  if (elements.currentRoomId) elements.currentRoomId.textContent = roomId || "----";
  if (elements.hostBadge) elements.hostBadge.classList.toggle("show", isHost);
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
