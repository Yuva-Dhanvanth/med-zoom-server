// ==========================
//      MINI ZOOM SERVER
// ==========================

import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  }
});

// Serve static files (public folder)
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==========================
//   IN-MEMORY USER STORAGE
// ==========================
let rooms = {}; 

// ==========================
//     SOCKET.IO HANDLERS
// ==========================

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // --------------------------
  // USER JOINS A ROOM
  // --------------------------
  socket.on("join-room", ({ roomId, name }) => {
    socket.join(roomId);

    // Create room if not exist
    if (!rooms[roomId]) {
      rooms[roomId] = {
        participants: {},
        host: socket.id // First user becomes host
      };
    }

    // Save user
    rooms[roomId].participants[socket.id] = {
      name: name || "Guest",
      isMuted: false,
      isVideoOn: true,
      isHost: socket.id === rooms[roomId].host
    };

    console.log(`User ${socket.id} (${name}) joined room ${roomId} - Host: ${rooms[roomId].host === socket.id}`);

    // Send room state to new user
    socket.emit("room-state", {
      participants: rooms[roomId].participants,
      isHost: rooms[roomId].host === socket.id,
      hostId: rooms[roomId].host
    });

    // Send existing users to new user (for WebRTC)
    const existingUsers = Object.keys(rooms[roomId].participants).filter(id => id !== socket.id);
    socket.emit("existing-users", existingUsers);

    // Notify others in the room
    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      name: name,
      isHost: false
    });

    // Update participants list for everyone
    io.to(roomId).emit("participants-updated", rooms[roomId].participants);
  });

  // ==========================
  //   HOST CONTROLS
  // ==========================
  socket.on("mute-user", ({ roomId, targetUserId }) => {
    const room = rooms[roomId];
    if (room && room.host === socket.id && room.participants[targetUserId]) {
      room.participants[targetUserId].isMuted = true;
      io.to(targetUserId).emit("force-mute");
      io.to(roomId).emit("participants-updated", room.participants);
    }
  });

  socket.on("unmute-user", ({ roomId, targetUserId }) => {
    const room = rooms[roomId];
    if (room && room.host === socket.id && room.participants[targetUserId]) {
      room.participants[targetUserId].isMuted = false;
      io.to(targetUserId).emit("force-unmute");
      io.to(roomId).emit("participants-updated", room.participants);
    }
  });

  socket.on("change-host", ({ roomId, newHostId }) => {
    const room = rooms[roomId];
    if (room && room.host === socket.id) {
      room.host = newHostId;
      
      // Update host status for all participants
      Object.keys(room.participants).forEach(id => {
        room.participants[id].isHost = (id === newHostId);
      });

      io.to(roomId).emit("host-changed", { newHostId });
      io.to(roomId).emit("participants-updated", room.participants);
    }
  });

  socket.on("remove-user", ({ roomId, targetUserId }) => {
    const room = rooms[roomId];
    if (room && room.host === socket.id) {
      // Notify user to leave
      io.to(targetUserId).emit("removed-from-room");
      
      // Remove from room
      delete room.participants[targetUserId];
      
      // If host removed themselves, assign new host
      if (targetUserId === room.host && Object.keys(room.participants).length > 0) {
        room.host = Object.keys(room.participants)[0];
        room.participants[room.host].isHost = true;
        io.to(room.host).emit("you-are-now-host");
      }

      io.to(roomId).emit("participants-updated", room.participants);
      io.to(roomId).emit("user-left", targetUserId);
    }
  });

  // ==========================
  //   SHARED POPUP MANAGEMENT
  // ==========================
  socket.on("open-ai-popup", ({ roomId, userName }) => {
    console.log(`🩺 ${userName} opened AI popup in room ${roomId}`);
    socket.to(roomId).emit("ai-popup-opened", { userName });
  });

  socket.on("close-ai-popup", ({ roomId, userName }) => {
    console.log(`❌ ${userName} closed AI popup in room ${roomId}`);
    socket.to(roomId).emit("ai-popup-closed", { userName });
  });

  // ==========================
  //   AI ANALYSIS BROADCAST
  // ==========================
  socket.on("ai-analysis-result", ({ roomId, imageData, prediction, confidence, userName }) => {
    console.log(`📊 AI analysis broadcast in room ${roomId} by ${userName}`);
    io.to(roomId).emit("ai-analysis-update", {
      imageData,
      prediction,
      confidence,
      userName
    });
  });

  // AI Analysis Status Events
  socket.on("ai-analysis-start", ({ roomId, userName }) => {
    console.log(`🔬 ${userName} started AI analysis in room ${roomId}`);
    socket.to(roomId).emit("ai-analysis-status", { 
      userName, 
      status: "analyzing",
      message: `${userName} is analyzing a medical image...`
    });
  });

  socket.on("ai-analysis-error", ({ roomId, userName, error }) => {
    console.log(`❌ AI analysis failed by ${userName}: ${error}`);
    socket.to(roomId).emit("ai-analysis-status", { 
      userName, 
      status: "error",
      message: `Analysis failed: ${error}`
    });
  });

  // --------------------------
  // WEBRTC EVENTS
  // --------------------------
  socket.on("offer", ({ offer, targetId }) => {
    io.to(targetId).emit("offer", {
      offer,
      senderId: socket.id
    });
  });

  socket.on("answer", ({ answer, targetId }) => {
    io.to(targetId).emit("answer", {
      answer,
      senderId: socket.id
    });
  });

  socket.on("ice-candidate", ({ candidate, targetId }) => {
    io.to(targetId).emit("ice-candidate", {
      candidate,
      senderId: socket.id
    });
  });

  // --------------------------
  // CHAT MESSAGE
  // --------------------------
  socket.on("chat-message", ({ roomId, message, name }) => {
    io.to(roomId).emit("chat-message", {
      message,
      name,
      time: Date.now()
    });
  });

  // --------------------------
  // USER DISCONNECTS
  // --------------------------
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    // Find which room user was in
    for (const roomId in rooms) {
      if (rooms[roomId].participants[socket.id]) {
        const room = rooms[roomId];
        const userName = room.participants[socket.id].name;

        delete room.participants[socket.id];

        // If host left, assign new host
        if (socket.id === room.host && Object.keys(room.participants).length > 0) {
          room.host = Object.keys(room.participants)[0];
          room.participants[room.host].isHost = true;
          io.to(room.host).emit("you-are-now-host");
        }

        // Remove room if empty
        if (Object.keys(room.participants).length === 0) {
          delete rooms[roomId];
        } else {
          // Notify others
          socket.to(roomId).emit("user-left", socket.id);
          io.to(roomId).emit("participants-updated", room.participants);
        }

        break;
      }
    }
  });
});

// ==========================
//        START SERVER
// ==========================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});