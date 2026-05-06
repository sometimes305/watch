import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const rooms = new Map();

function roomState() {
  return {
    videoId: "",
    title: "",
    time: 0,
    playing: false,
    updatedAt: Date.now(),
    messages: [],
    clients: new Map(),
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, roomState());
  return rooms.get(roomId);
}

function computedPlayback(room) {
  if (!room.playing) return room.time;
  return room.time + (Date.now() - room.updatedAt) / 1000;
}

function publicRoom(room) {
  return {
    videoId: room.videoId,
    title: room.title,
    time: computedPlayback(room),
    playing: room.playing,
    updatedAt: Date.now(),
  };
}

function roster(room) {
  return Array.from(room.clients.values()).map((client) => ({
    id: client.id,
    name: client.name,
    color: client.color,
    avatar: client.avatar,
    gravityUserId: client.gravityUserId,
  }));
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload) {
  for (const client of room.clients.values()) {
    send(client.ws, payload);
  }
}

function safeRoute(url) {
  const parsed = new URL(url, "http://localhost");
  const pathname = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const resolved = normalize(join(publicDir, pathname));
  return resolved.startsWith(publicDir) ? resolved : join(publicDir, "index.html");
}

const server = createServer(async (req, res) => {
  try {
    let path = safeRoute(req.url || "/");
    if (!existsSync(path)) path = join(publicDir, "index.html");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": mimeTypes.get(extname(path)) || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client = {
    id: crypto.randomUUID(),
    name: "guest",
    color: "#2f7d72",
    avatar: "",
    gravityUserId: "",
    roomId: "",
    ws,
  };

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "join") {
      client.roomId = String(message.roomId || "lobby").slice(0, 64);
      client.name = String(message.name || "guest").slice(0, 24);
      client.color = String(message.color || "#2f7d72").slice(0, 16);
      client.avatar = String(message.avatar || "").slice(0, 500);
      client.gravityUserId = String(message.gravityUserId || "").slice(0, 64);
      const room = getRoom(client.roomId);
      room.clients.set(client.id, client);
      send(ws, {
        type: "joined",
        you: {
          id: client.id,
          name: client.name,
          color: client.color,
          avatar: client.avatar,
          gravityUserId: client.gravityUserId,
        },
        state: publicRoom(room),
        messages: room.messages,
        roster: roster(room),
      });
      broadcast(room, { type: "roster", roster: roster(room) });
      return;
    }

    if (!client.roomId) return;
    const room = getRoom(client.roomId);

    if (message.type === "loadVideo") {
      room.videoId = String(message.videoId || "").slice(0, 32);
      room.title = String(message.title || "YouTube video").slice(0, 120);
      room.time = 0;
      room.playing = false;
      room.updatedAt = Date.now();
      broadcast(room, { type: "videoLoaded", state: publicRoom(room), actor: client.name });
      return;
    }

    if (message.type === "playerAction") {
      const currentTime = Number.isFinite(message.time) ? Math.max(0, Number(message.time)) : computedPlayback(room);
      room.time = currentTime;
      room.playing = message.action === "play";
      room.updatedAt = Date.now();
      broadcast(room, { type: "playerAction", state: publicRoom(room), actor: client.name });
      return;
    }

    if (message.type === "seek") {
      room.time = Number.isFinite(message.time) ? Math.max(0, Number(message.time)) : 0;
      room.updatedAt = Date.now();
      broadcast(room, { type: "seek", state: publicRoom(room), actor: client.name });
      return;
    }

    if (message.type === "chat") {
      const text = String(message.text || "").trim().slice(0, 500);
      if (!text) return;
      const chat = {
        id: crypto.randomUUID(),
        text,
        name: client.name,
        color: client.color,
        avatar: client.avatar,
        gravityUserId: client.gravityUserId,
        at: Date.now(),
      };
      room.messages.push(chat);
      room.messages = room.messages.slice(-80);
      broadcast(room, { type: "chat", message: chat });
    }
  });

  ws.on("close", () => {
    if (!client.roomId) return;
    const room = getRoom(client.roomId);
    room.clients.delete(client.id);
    broadcast(room, { type: "roster", roster: roster(room) });
    if (room.clients.size === 0 && !room.videoId && room.messages.length === 0) rooms.delete(client.roomId);
  });
});

server.listen(port, () => {
  console.log(`Gravity watch party is running at http://localhost:${port}`);
});
