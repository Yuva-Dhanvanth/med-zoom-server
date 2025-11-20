// server.js
// ============================================================================
// This is our Node.js backend server.
//
// It does 3 main jobs:
//
// 1. Serve the frontend files (index.html, room.html, style.css, script.js).
// 2. Run Socket.IO for "signaling" and chat:
//      - join-room
//      - WebRTC offers/answers
//      - ICE candidates
//      - chat messages
// 3. Provide WebRTC ICE servers (STUN + TURN) so peers can connect even on
//    different Wi-Fi / hotspot / behind NAT.
//
// IMPORTANT CONCEPTS (simple):
// - STUN: helps your browser find its public IP/port.
// - TURN: relays audio/video when direct P2P is blocked (different Wi-Fi,
//         strict firewalls, mobile data, etc.).
// - Socket.IO: used only for signaling + chat, NOT for video/audio itself.
// ============================================================================

require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// We allow any origin for simplicity (localhost, ngrok URL, etc.)
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================================
// ICE SERVERS SETUP (STUN + TURN)
// ============================================================================
//
// We will use OpenRelay (Metered) as a FREE TURN server by default.
// You can override these with your own TURN server by setting .env values.
//
// In your .env you can put (recommended):
//
//   TURN_USERNAME=openrelayproject
//   TURN_PASSWORD=openrelayproject
//   PORT=3000
//
// Or, if you have your own TURN server, change them there.
// ============================================================================

const TURN_USERNAME =
  process.env.TURN_USERNAME && process.env.TURN_USERNAME.trim().length > 0
    ? process.env.TURN_USERNAME.trim()
    : "openrelayproject";

const TURN_PASSWORD =
  process.env.TURN_PASSWORD && process.env.TURN_PASSWORD.trim().length > 0
    ? process.env.TURN_PASSWORD.trim()
    : "openrelayproject";

// Base STUN servers (discover public IP/port)
const iceServers = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:openrelay.metered.ca:3478",
    ],
  },
];

// Add TURN servers (relay media when needed)
if (TURN_USERNAME && TURN_PASSWORD) {
  iceServers.push({
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turns:openrelay.metered.ca:443?transport=tcp",
    ],
    username: TURN_USERNAME,
    credential: TURN_PASSWORD,
  });
}

console.log("ICE servers being used:", JSON.stringify(iceServers, null, 2));

// ============================================================================
// ROOM / SOCKET.IO LOGIC
// ============================================================================
//
// rooms object structure:
//
// rooms = {
//   [roomId]: {
//       [socketId]: username
//   }
// }
// ============================================================================

const rooms = {};

io.on("connection", (socket) => {
  console.log("✅ A user connected:", socket.id);

  // When a client wants to join a room
  socket.on("join-room", ({ roomId, username }) => {
    console.log(
      `📢 Socket ${socket.id} joining room "${roomId}" as "${username}"`
    );

    // Save on socket for easy access later (disconnect, chat, etc.)
    socket.data.roomId = roomId;
    socket.data.username = username;

    // Join Socket.IO room
    socket.join(roomId);

    // Track in our in-memory room list
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = username;

    // Build a participants array for this room
    const participants = Object.entries(rooms[roomId]).map(([id, name]) => ({
      id,
      username: name,
    }));

    // Tell the new user they joined + give them participants + ICE servers
    socket.emit("room-joined", {
      roomId,
      yourId: socket.id,
      participants,
      iceServers, // <-- client uses this in RTCPeerConnection
    });

    // Tell everyone else in the room that a new user joined
    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      username,
    });
  });

  // Forward WebRTC OFFER from one peer to another
  socket.on("signal-offer", ({ roomId, to, offer }) => {
    console.log(`📨 Offer from ${socket.id} to ${to} in room "${roomId}"`);
    io.to(to).emit("signal-offer", { from: socket.id, offer });
  });

  // Forward WebRTC ANSWER
  socket.on("signal-answer", ({ roomId, to, answer }) => {
    console.log(`📨 Answer from ${socket.id} to ${to} in room "${roomId}"`);
    io.to(to).emit("signal-answer", { from: socket.id, answer });
  });

  // Forward ICE candidate
  socket.on("signal-ice-candidate", ({ roomId, to, candidate }) => {
    // console.log(`📨 ICE candidate from ${socket.id} to ${to}`);
    io.to(to).emit("signal-ice-candidate", { from: socket.id, candidate });
  });

  // Public chat in a room
  socket.on("send-chat-message", ({ roomId, message }) => {
    const username = socket.data.username || "Unknown";
    io.to(roomId).emit("chat-message", {
      username,
      message,
      time: new Date().toISOString(),
    });
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;

    console.log("❌ User disconnected:", socket.id, "from room:", roomId);

    if (roomId && rooms[roomId]) {
      // Remove from room list
      delete rooms[roomId][socket.id];

      // If room is empty now, delete it
      if (Object.keys(rooms[roomId]).length === 0) {
        delete rooms[roomId];
      }

      // Notify remaining users
      socket.to(roomId).emit("user-left", {
        socketId: socket.id,
        username,
      });
    }
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});

