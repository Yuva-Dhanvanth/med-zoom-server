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
    if (!rooms[roomId]) rooms[roomId] = {};

    // Save user
    rooms[roomId][socket.id] = name || "Guest";

    console.log(`User ${socket.id} (${rooms[roomId][socket.id]}) joined room ${roomId}`);

    // Send existing users to new user
    const existingUsers = Object.keys(rooms[roomId]).filter(id => id !== socket.id);
    socket.emit("existing-users", existingUsers);

    // Notify others in the room
    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      name: rooms[roomId][socket.id]
    });

    // Update participants list
    io.to(roomId).emit("room-users", rooms[roomId]);
  });

  // ==========================
  //   SHARED POPUP MANAGEMENT
  // ==========================
  socket.on("open-ai-popup", ({ roomId, userName }) => {
    console.log(`🩺 ${userName} opened AI popup in room ${roomId}`);
    // Broadcast to everyone except sender
    socket.to(roomId).emit("ai-popup-opened", { userName });
  });

  socket.on("close-ai-popup", ({ roomId, userName }) => {
    console.log(`❌ ${userName} closed AI popup in room ${roomId}`);
    // Broadcast to everyone except sender
    socket.to(roomId).emit("ai-popup-closed", { userName });
  });

  // ==========================
  //   AI ANALYSIS BROADCAST
  // ==========================
  socket.on("ai-analysis-result", ({ roomId, imageData, prediction, confidence, userName }) => {
    console.log(`📊 AI analysis broadcast in room ${roomId} by ${userName}`);
    
    // Broadcast to everyone in the room including sender
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
  // OFFER SENT TO A USER
  // --------------------------
  socket.on("offer", ({ offer, targetId }) => {
    io.to(targetId).emit("offer", {
      offer,
      senderId: socket.id
    });
  });

  // --------------------------
  // ANSWER SENT BACK
  // --------------------------
  socket.on("answer", ({ answer, targetId }) => {
    io.to(targetId).emit("answer", {
      answer,
      senderId: socket.id
    });
  });

  // --------------------------
  // ICE CANDIDATES
  // --------------------------
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
      if (rooms[roomId][socket.id]) {
        const name = rooms[roomId][socket.id];

        delete rooms[roomId][socket.id];

        // Notify others
        socket.to(roomId).emit("user-left", socket.id);

        // Update participants list
        io.to(roomId).emit("room-users", rooms[roomId]);

        // Remove room if empty
        if (Object.keys(rooms[roomId]).length === 0) {
          delete rooms[roomId];
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