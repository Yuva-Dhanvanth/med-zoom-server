// ===============================
//   MEDIZOOM - CLIENT LOGIC
// ===============================

const AI_SERVER_URL = "http://127.0.0.1:5000";

let socket = null;
let localStream = null;
let peers = {};
let remoteVideoElements = {};
let roomId = null;
let username = null;
let isHost = false;
let participants = {};
let annotationTool = null;
let userColors = {};
let currentImageData = null;

const iceServers = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] }
  ]
};

// ===============================
//   PAGE INITIALIZATION
// ===============================
document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "home") initHomePage();
  if (page === "room") initRoomPage();
});

function initHomePage() {
  const joinForm = document.getElementById("joinForm");
  const roomInput = document.getElementById("roomInput");
  const nameInput = document.getElementById("nameInput");
  const errorBox = document.getElementById("homeError");

  joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const room = roomInput.value.trim();
    const name = nameInput.value.trim() || "Guest";
    
    if (!room) {
      errorBox.textContent = "Please enter a room number.";
      return;
    }

    try {
      await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      alert("Camera or mic error");
      return;
    }

    window.location.href = `room.html?room=${room}&name=${encodeURIComponent(name)}`;
  });
}

async function initRoomPage() {
  const params = new URLSearchParams(window.location.search);
  roomId = params.get("room");
  username = params.get("name") || "Guest";

  document.getElementById("roomLabel").textContent = roomId;
  document.getElementById("usernameLabel").textContent = username;

  socket = io();
  registerSocketEvents();
  await initLocalMedia();
  socket.emit("join-room", { roomId, name: username });
  setupControls();
  setupAIIntegration();
}

// ===============================
//   MEDIA STREAM
// ===============================
async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    const wrapper = document.createElement("div");
    wrapper.className = "remote-video-wrapper local-tile";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = localStream;
    video.className = "remote-video";

    const label = document.createElement("div");
    label.textContent = `${username} (You) ${isHost ? '👑' : ''}`;
    label.className = "video-label";

    wrapper.appendChild(video);
    wrapper.appendChild(label);

    const existing = document.querySelector(".local-tile");
    if (existing) existing.remove();

    document.getElementById("remoteVideos").appendChild(wrapper);

  } catch (err) {
    console.error("Media error:", err);
    alert("Unable to access camera/microphone.");
  }
}

// ===============================
//   SOCKET.IO EVENTS
// ===============================
function registerSocketEvents() {
  socket.on("room-state", ({ participants: roomParticipants, isHost: hostStatus, hostId }) => {
    participants = roomParticipants;
    isHost = hostStatus;
    updateParticipantsList(participants);
    updateHostUI();
  });

  socket.on("existing-users", (userIds) => {
    userIds.forEach((id) => createPeerConnection(id, true));
  });

  socket.on("user-joined", ({ socketId, name }) => {
    createPeerConnection(socketId, false);
  });

  socket.on("participants-updated", (updatedParticipants) => {
    participants = updatedParticipants;
    updateParticipantsList(participants);
    updateVideoLabels();
  });

  socket.on("you-are-now-host", () => {
    isHost = true;
    updateHostUI();
    showNotification("You are now the host");
  });

  socket.on("drawing-action", (data) => {
    // Only process drawings from other users
    if (data.userId !== socket.id && annotationTool) {
      annotationTool.handleRemoteDrawing(data);
      
      if (!userColors[data.userId]) {
        userColors[data.userId] = data.data.color || '#4CAF50';
        if (annotationTool.updateUserIndicators) {
          annotationTool.updateUserIndicators();
        }
      }
    }
  });

  socket.on("ai-report-update", ({ report, userName }) => {
    if (userName !== username) {
      const reportResult = document.getElementById("reportResult");
      reportResult.innerHTML = `
        <div class="shared-by">AI Medical Report (by ${userName})</div>
        <div>${report}</div>
      `;
      reportResult.className = "ai-report-result-integrated";
    }
  });

  socket.on("host-changed", ({ newHostId }) => {
    if (newHostId === socket.id) {
      isHost = true;
      updateHostUI();
      showNotification("You are now the host");
    }
    updateParticipantsList(participants);
  });

  socket.on("force-mute", () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = false;
      document.getElementById("btnToggleMic").textContent = "🔇 Unmute";
      showNotification("Host muted your microphone");
    }
  });

  socket.on("force-unmute", () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = true;
      document.getElementById("btnToggleMic").textContent = "🎙️ Mute";
      showNotification("Host unmuted your microphone");
    }
  });

  socket.on("removed-from-room", () => {
    alert("You have been removed from the meeting by the host");
    window.location.href = "index.html";
  });

  // WebRTC Events
  socket.on("offer", async ({ offer, senderId }) => {
    if (!peers[senderId]) createPeerConnection(senderId, false);
    
    try {
      await peers[senderId].setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peers[senderId].createAnswer();
      await peers[senderId].setLocalDescription(answer);
      socket.emit("answer", { answer, targetId: senderId });
    } catch (err) {
      console.error("Failed to handle offer:", err);
    }
  });

  socket.on("answer", async ({ answer, senderId }) => {
    const pc = peers[senderId];
    if (!pc) return;
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error("Failed to set remote description:", err);
    }
  });

  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    if (peers[senderId]) {
      try {
        await peers[senderId].addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("ICE candidate error:", e);
      }
    }
  });

  socket.on("user-left", (socketId) => {
    removePeer(socketId);
    updateParticipantsList(participants);
  });

  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });

  // AI Analysis Events
  socket.on("ai-analysis-update", ({ imageData, prediction, confidence, userName }) => {
    updateAIDisplay(imageData, prediction, confidence, userName);
    addChatMessage("System", `${userName} shared a medical image analysis: ${prediction} (${(confidence * 100).toFixed(1)}%)`);
  });

  socket.on("ai-analysis-status", ({ userName, status, message }) => {
    const aiResult = document.getElementById("aiResult");
    if (aiResult && status === "analyzing") {
      aiResult.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 10px;">
          <div style="font-size: 1.5rem; margin-bottom: 8px;">🔬</div>
          <div><strong>${userName}</strong> is analyzing a medical image</div>
          <div style="font-size: 0.8rem; margin-top: 6px;">${message}</div>
        </div>
      `;
    }
  });
}

// ===============================
//   HOST CONTROLS
// ===============================
function updateHostUI() {
  const hostBadge = document.getElementById("hostBadge");
  if (hostBadge) {
    hostBadge.style.display = isHost ? "inline-block" : "none";
  }
}

function generateParticipantsListHTML() {
  let html = '';
  
  for (const [socketId, participant] of Object.entries(participants)) {
    const isYou = socketId === socket.id;
    const isParticipantHost = participant.isHost;
    
    html += `
      <div class="participant-item ${isYou ? 'you' : ''}">
        <div class="participant-avatar">${participant.name.charAt(0).toUpperCase()}</div>
        <div class="participant-info">
          <div class="participant-name">
            ${participant.name} 
            ${isYou ? '<span class="you-badge">You</span>' : ''}
            ${isParticipantHost ? '<span class="host-badge">👑 Host</span>' : ''}
          </div>
          <div class="participant-status">
            ${participant.isMuted ? '🔇 Muted' : '🎙️ Unmuted'} • 
            ${participant.isVideoOn ? '📹 Video On' : '📹 Video Off'}
          </div>
        </div>
        ${isHost && !isYou ? `
          <div class="participant-actions">
            <button class="btn-small" onclick="toggleMuteUser('${socketId}', ${!participant.isMuted})">
              ${participant.isMuted ? '🔊 Unmute' : '🔇 Mute'}
            </button>
            <button class="btn-small" onclick="makeHost('${socketId}')">
              👑 Make Host
            </button>
            <button class="btn-small btn-danger" onclick="removeUser('${socketId}')">
              🚪 Remove
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  return html;
}

function toggleMuteUser(userId, mute) {
  if (mute) {
    socket.emit("mute-user", { roomId, targetUserId: userId });
  } else {
    socket.emit("unmute-user", { roomId, targetUserId: userId });
  }
}

function makeHost(userId) {
  if (confirm(`Make ${participants[userId]?.name} the new host?`)) {
    socket.emit("change-host", { roomId, newHostId: userId });
  }
}

function removeUser(userId) {
  if (confirm(`Remove ${participants[userId]?.name} from the meeting?`)) {
    socket.emit("remove-user", { roomId, targetUserId: userId });
  }
}

function showNotification(message) {
  const notification = document.createElement("div");
  notification.className = "notification";
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: var(--accent);
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    z-index: 10000;
    box-shadow: var(--shadow-soft);
  `;
  
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 3000);
}

// ===============================
//   CONTROLS SETUP
// ===============================
function setupControls() {
  const btnParticipants = document.getElementById("btnParticipants");
  const closeParticipantsPopup = document.getElementById("closeParticipantsPopup");
  const participantsPopup = document.getElementById("participantsPopup");

  btnParticipants.addEventListener("click", () => {
    participantsPopup.style.display = "flex";
  });

  closeParticipantsPopup.addEventListener("click", () => {
    participantsPopup.style.display = "none";
  });

  participantsPopup.addEventListener("click", (e) => {
    if (e.target === participantsPopup) {
      participantsPopup.style.display = "none";
    }
  });

  setupMediaControls();
}

function setupMediaControls() {
  const btnMic = document.getElementById("btnToggleMic");
  const btnCam = document.getElementById("btnToggleCamera");
  const btnScreen = document.getElementById("btnShareScreen");
  const btnLeave = document.getElementById("btnLeave");

  btnMic.addEventListener("click", () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      btnMic.textContent = audioTrack.enabled ? "🎙️ Mute" : "🔇 Unmute";
      if (participants[socket.id]) {
        participants[socket.id].isMuted = !audioTrack.enabled;
      }
    }
  });

  btnCam.addEventListener("click", () => {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      btnCam.textContent = videoTrack.enabled ? "📷 Camera Off" : "📷 Camera On";
      if (participants[socket.id]) {
        participants[socket.id].isVideoOn = videoTrack.enabled;
      }
    }
  });

  btnScreen.addEventListener("click", async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      for (const id in peers) {
        const sender = peers[id].getSenders().find(s => s.track?.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      }

      screenTrack.onended = () => {
        const cameraTrack = localStream?.getVideoTracks()[0];
        for (const id in peers) {
          const sender = peers[id].getSenders().find(s => s.track?.kind === "video");
          if (sender && cameraTrack) sender.replaceTrack(cameraTrack);
        }
      };
    } catch (err) {
      console.error("Screen share error:", err);
    }
  });

  btnLeave.addEventListener("click", () => {
    if (socket) socket.disconnect();
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    window.location.href = "index.html";
  });
}

function updateParticipantsList(updatedParticipants) {
  participants = updatedParticipants;
  const participantsList = document.getElementById("participantsList");
  if (!participantsList) return;
  participantsList.innerHTML = generateParticipantsListHTML();
}

function updateVideoLabels() {
  const localVideo = document.querySelector('.local-tile .video-label');
  if (localVideo) {
    localVideo.textContent = `${username} (You) ${isHost ? '👑' : ''}`;
  }

  for (const [socketId, participant] of Object.entries(participants)) {
    if (socketId !== socket.id && remoteVideoElements[socketId]) {
      const remoteLabel = remoteVideoElements[socketId].querySelector('.video-label');
      if (remoteLabel) {
        remoteLabel.textContent = `${participant.name} ${participant.isHost ? '👑' : ''}`;
      }
    }
  }
}

// ===============================
//   AI INTEGRATION
// ===============================
function setupAIIntegration() {
  const aiForm = document.getElementById("aiForm");
  const aiFile = document.getElementById("aiFile");
  const analysisResults = document.getElementById("analysisResults");
  const generateReportBtn = document.getElementById("generateReportBtn");
  const reportLoading = document.getElementById("reportLoading");
  const reportResult = document.getElementById("reportResult");

  initAnnotationTools();
  setupAnnotationToolEvents();

  aiForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = aiFile.files[0];
    if (!file) {
      const aiResult = document.getElementById("aiResult");
      if (aiResult) aiResult.textContent = "Please choose an image file.";
      return;
    }

    socket.emit("ai-analysis-start", { roomId, userName: username });

    const reader = new FileReader();
    reader.onload = async function(e) {
      currentImageData = e.target.result;
      
      const aiImagePreview = document.getElementById("aiImagePreview");
      if (aiImagePreview) {
        aiImagePreview.src = currentImageData;
        aiImagePreview.style.display = "block";
      }
      
      if (analysisResults) analysisResults.style.display = "block";
      
      if (aiImagePreview) {
        aiImagePreview.onload = function() {
          if (annotationTool) annotationTool.resizeCanvasToImage();
        };
      }
      
      const aiResult = document.getElementById("aiResult");
      if (aiResult) aiResult.textContent = "Analyzing medical image...";

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch(`${AI_SERVER_URL}/predict`, {
          method: "POST",
          body: formData,
          headers: { 'ngrok-skip-browser-warning': 'true' }
        });

        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        
        const data = await res.json();
        if (!data?.prediction) throw new Error("Invalid response from AI server");

        if (aiResult) {
          aiResult.innerHTML = `
            <div class="shared-by">Shared by: You</div>
            <div><strong>Prediction:</strong> ${escapeHtml(String(data.prediction))}</div>
            <div><strong>Confidence:</strong> ${Number(data.confidence).toFixed(4)}</div>
          `;
        }

        saveAnalysisResults(currentImageData, data.prediction, data.confidence);

        if (reportResult) reportResult.innerHTML = "";
        if (reportLoading) reportLoading.style.display = "none";

        socket.emit("ai-analysis-result", {
          roomId,
          imageData: currentImageData,
          prediction: data.prediction,
          confidence: data.confidence,
          userName: username
        });

      } catch (err) {
        console.error("AI analysis failed:", err);
        const aiResult = document.getElementById("aiResult");
        if (aiResult) aiResult.textContent = "Error processing image. Please try again.";
      }
    };
    reader.readAsDataURL(file);
  });

  generateReportBtn.addEventListener("click", async () => {
    if (!currentImageData) {
      alert("Please analyze an image first.");
      return;
    }

    if (reportLoading) reportLoading.style.display = "block";
    if (reportResult) reportResult.innerHTML = "";
    generateReportBtn.disabled = true;

    try {
      const report = await generateAIMedicalReport(currentImageData);
      
      if (reportResult) {
        reportResult.innerHTML = `
          <div class="shared-by">AI Medical Report</div>
          <div>${report}</div>
        `;
        reportResult.className = "ai-report-result-integrated";
      }

      socket.emit("ai-report-generated", { roomId, report, userName: username });

    } catch (error) {
      console.error("Report generation failed:", error);
      if (reportResult) {
        reportResult.innerHTML = "❌ Failed to generate report. Please try again.";
        reportResult.className = "ai-report-result-integrated report-error";
      }
    } finally {
      if (reportLoading) reportLoading.style.display = "none";
      generateReportBtn.disabled = false;
    }
  });

  // Chat Handler
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");

  if (chatForm) {
    chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const msg = chatInput.value.trim();
      if (!msg) return;
      socket.emit("chat-message", { roomId, message: msg, name: username });
      addChatMessage("You", msg);
      chatInput.value = "";
    });
  }
}

// ===============================
//   ANNOTATION TOOLS - FIXED
// ===============================
class AnnotationTool {
  constructor() {
    this.canvas = document.getElementById('annotationCanvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.isDrawing = false;
    this.currentTool = 'pen';
    this.currentColor = '#4CAF50';
    this.brushSize = 3;
    this.lastX = 0;
    this.lastY = 0;
    this.startX = 0;
    this.startY = 0;
    this.userId = socket.id;
    this.drawingHistory = [];
    this.tempCanvas = document.createElement('canvas');
    this.tempCtx = this.tempCanvas.getContext('2d');
    this.isShapePreview = false;
    
    this.setupEventListeners();
    this.assignUserColor();
    this.saveState();
  }

  setupEventListeners() {
    this.canvas.addEventListener('mousedown', this.startDrawing.bind(this));
    this.canvas.addEventListener('mousemove', this.draw.bind(this));
    this.canvas.addEventListener('mouseup', this.stopDrawing.bind(this));
    this.canvas.addEventListener('mouseout', this.stopDrawing.bind(this));
    
    this.canvas.addEventListener('touchstart', this.startDrawing.bind(this));
    this.canvas.addEventListener('touchmove', this.draw.bind(this));
    this.canvas.addEventListener('touchend', this.stopDrawing.bind(this));
  }

  assignUserColor() {
    const colors = ['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336', '#00BCD4', '#FFEB3B', '#795548', '#607D8B', '#E91E63'];
    
    if (userColors[this.userId]) {
      this.currentColor = userColors[this.userId];
    } else {
      const usedColors = Object.values(userColors);
      const availableColors = colors.filter(color => !usedColors.includes(color));
      
      if (availableColors.length > 0) {
        userColors[this.userId] = availableColors[Math.floor(Math.random() * availableColors.length)];
      } else {
        userColors[this.userId] = colors[Object.keys(userColors).length % colors.length];
      }
      
      this.currentColor = userColors[this.userId];
    }
    
    document.getElementById('colorPicker').value = this.currentColor;
    document.getElementById('userColorBadge').style.backgroundColor = this.currentColor;
    this.updateUserIndicators();
  }

  updateUserIndicators() {
    const container = document.getElementById('userIndicators');
    if (!container) return;
    
    container.innerHTML = '';
    
    Object.entries(userColors).forEach(([userId, color]) => {
      const participant = participants[userId];
      if (participant) {
        const indicator = document.createElement('div');
        indicator.className = 'user-indicator';
        indicator.innerHTML = `
          <div class="user-indicator-color" style="background-color: ${color};"></div>
          <span>${participant.name}</span>
        `;
        container.appendChild(indicator);
      }
    });
  }

  setTool(tool) {
    this.currentTool = tool;
    this.updateCanvasCursor();
  }

  updateCanvasCursor() {
    if (this.currentTool === 'eraser') {
      this.canvas.style.cursor = 'cell';
    } else if (this.isShapeTool()) {
      this.canvas.style.cursor = 'crosshair';
    } else {
      this.canvas.style.cursor = 'crosshair';
    }
  }

  setColor(color) {
    this.currentColor = color;
    userColors[this.userId] = color;
    this.updateUserIndicators();
  }

  setBrushSize(size) {
    this.brushSize = parseInt(size);
  }

  startDrawing(e) {
    e.preventDefault();
    this.isDrawing = true;
    const pos = this.getMousePos(e);
    [this.startX, this.startY] = [pos.x, pos.y];
    [this.lastX, this.lastY] = [pos.x, pos.y];

    if (this.isShapeTool()) {
      this.tempCanvas.width = this.canvas.width;
      this.tempCanvas.height = this.canvas.height;
      this.isShapePreview = true;
    }
    
    // Save state before starting new drawing
    this.saveState();
    
    broadcastDrawingAction('start', {
      tool: this.currentTool,
      color: this.currentColor,
      brushSize: this.brushSize,
      x: this.startX,
      y: this.startY
    });
  }

  draw(e) {
    if (!this.isDrawing) return;
    
    e.preventDefault();
    const pos = this.getMousePos(e);
    const currentX = pos.x;
    const currentY = pos.y;

    if (this.isShapeTool() && this.isShapePreview) {
      this.drawShapePreview(this.startX, this.startY, currentX, currentY);
    } else {
      this.drawFreehand(currentX, currentY);
    }

    [this.lastX, this.lastY] = [currentX, currentY];
  }

  drawFreehand(currentX, currentY) {
    this.ctx.lineWidth = this.brushSize;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    if (this.currentTool === 'eraser') {
      this.ctx.globalCompositeOperation = 'destination-out';
      this.ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else if (this.currentTool === 'highlighter') {
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.strokeStyle = this.currentColor + '80';
      this.ctx.lineWidth = this.brushSize * 3;
    } else {
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.strokeStyle = this.currentColor;
    }

    this.ctx.beginPath();
    this.ctx.moveTo(this.lastX, this.lastY);
    this.ctx.lineTo(currentX, currentY);
    this.ctx.stroke();

    broadcastDrawingAction('draw', {
      tool: this.currentTool,
      color: this.currentColor,
      brushSize: this.brushSize,
      fromX: this.lastX,
      fromY: this.lastY,
      toX: currentX,
      toY: currentY
    });
  }

  drawShapePreview(startX, startY, currentX, currentY) {
    this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
    this.tempCtx.drawImage(this.canvas, 0, 0);
    
    this.tempCtx.strokeStyle = this.currentColor;
    this.tempCtx.lineWidth = this.brushSize;
    this.tempCtx.setLineDash([5, 5]);
    this.tempCtx.globalAlpha = 0.7;
    
    switch (this.currentTool) {
      case 'rectangle':
        const rectWidth = currentX - startX;
        const rectHeight = currentY - startY;
        this.tempCtx.strokeRect(startX, startY, rectWidth, rectHeight);
        break;
      case 'circle':
        const radius = Math.sqrt(Math.pow(currentX - startX, 2) + Math.pow(currentY - startY, 2));
        this.tempCtx.beginPath();
        this.tempCtx.arc(startX, startY, radius, 0, 2 * Math.PI);
        this.tempCtx.stroke();
        break;
      case 'arrow':
        this.drawArrow(this.tempCtx, startX, startY, currentX, currentY, true);
        break;
    }
    
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.canvas, 0, 0);
    this.ctx.drawImage(this.tempCanvas, 0, 0);
  }

  drawArrow(ctx, fromX, fromY, toX, toY, isPreview = false) {
    const headLength = 15;
    const angle = Math.atan2(toY - fromY, toX - fromX);
    
    if (isPreview) {
      ctx.setLineDash([5, 5]);
      ctx.globalAlpha = 0.7;
    } else {
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
    }
    
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
    
    ctx.setLineDash([]);
    ctx.globalAlpha = 1.0;
  }

  stopDrawing() {
    if (!this.isDrawing) return;
    
    this.isDrawing = false;
    
    if (this.isShapeTool() && this.isShapePreview) {
      this.finalizeShape();
      this.isShapePreview = false;
    }
    
    this.saveState();
    broadcastDrawingAction('stop', {});
  }

  finalizeShape() {
    this.ctx.strokeStyle = this.currentColor;
    this.ctx.lineWidth = this.brushSize;
    this.ctx.setLineDash([]);
    this.ctx.globalAlpha = 1.0;
    
    switch (this.currentTool) {
      case 'rectangle':
        const rectWidth = this.lastX - this.startX;
        const rectHeight = this.lastY - this.startY;
        this.ctx.strokeRect(this.startX, this.startY, rectWidth, rectHeight);
        break;
      case 'circle':
        const radius = Math.sqrt(Math.pow(this.lastX - this.startX, 2) + Math.pow(this.lastY - this.startY, 2));
        this.ctx.beginPath();
        this.ctx.arc(this.startX, this.startY, radius, 0, 2 * Math.PI);
        this.ctx.stroke();
        break;
      case 'arrow':
        this.drawArrow(this.ctx, this.startX, this.startY, this.lastX, this.lastY, false);
        break;
    }

    broadcastDrawingAction('shape', {
      tool: this.currentTool,
      color: this.currentColor,
      brushSize: this.brushSize,
      startX: this.startX,
      startY: this.startY,
      endX: this.lastX,
      endY: this.lastY
    });
  }

  isShapeTool() {
    return ['rectangle', 'circle', 'arrow'].includes(this.currentTool);
  }

  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);
    
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  clearCanvas() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.saveState();
    broadcastDrawingAction('clear', {});
  }

  saveState() {
    const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.drawingHistory.push(imageData);
    
    if (this.drawingHistory.length > 50) {
      this.drawingHistory.shift();
    }
  }

  undo() {
    if (this.drawingHistory.length > 1) {
      this.drawingHistory.pop();
      const previousState = this.drawingHistory[this.drawingHistory.length - 1];
      this.ctx.putImageData(previousState, 0, 0);
      broadcastDrawingAction('undo', {});
    } else if (this.drawingHistory.length === 1) {
      this.clearCanvas();
    }
  }

  resizeCanvasToImage() {
    const img = document.getElementById('aiImagePreview');
    if (img && img.naturalWidth) {
      this.canvas.width = img.naturalWidth;
      this.canvas.height = img.naturalHeight;
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.saveState();
    }
  }

  handleRemoteDrawing(data) {
    if (data.userId === this.userId) return;
    
    console.log("🖌️ Processing remote drawing from:", data.userId);
    
    if (!userColors[data.userId] && data.data.color) {
      userColors[data.userId] = data.data.color;
      this.updateUserIndicators();
    }

    // Save current state before applying remote changes
    this.saveState();

    // Apply the remote drawing action
    this.applyRemoteDrawingAction(data);
    
    console.log("✅ Remote drawing applied successfully");
  }

  applyRemoteDrawingAction(data) {
    this.ctx.lineWidth = data.data.brushSize || this.brushSize;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = userColors[data.userId] || data.data.color || '#4CAF50';
    
    switch (data.action) {
      case 'start':
        this.ctx.beginPath();
        this.ctx.moveTo(data.data.x, data.data.y);
        break;
        
      case 'draw':
        if (data.data.tool === 'eraser') {
          this.ctx.globalCompositeOperation = 'destination-out';
          this.ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else if (data.data.tool === 'highlighter') {
          this.ctx.globalCompositeOperation = 'source-over';
          this.ctx.strokeStyle = (userColors[data.userId] || data.data.color || '#4CAF50') + '80';
          this.ctx.lineWidth = (data.data.brushSize || this.brushSize) * 3;
        } else {
          this.ctx.globalCompositeOperation = 'source-over';
          this.ctx.strokeStyle = userColors[data.userId] || data.data.color || '#4CAF50';
        }
        
        this.ctx.beginPath();
        this.ctx.moveTo(data.data.fromX, data.data.fromY);
        this.ctx.lineTo(data.data.toX, data.data.toY);
        this.ctx.stroke();
        
        this.ctx.globalCompositeOperation = 'source-over';
        break;
        
      case 'shape':
        this.ctx.strokeStyle = userColors[data.userId] || data.data.color || '#4CAF50';
        this.ctx.lineWidth = data.data.brushSize || this.brushSize;
        this.ctx.setLineDash([]);
        
        switch (data.data.tool) {
          case 'rectangle':
            const rectWidth = data.data.endX - data.data.startX;
            const rectHeight = data.data.endY - data.data.startY;
            this.ctx.strokeRect(data.data.startX, data.data.startY, rectWidth, rectHeight);
            break;
          case 'circle':
            const radius = Math.sqrt(
              Math.pow(data.data.endX - data.data.startX, 2) + 
              Math.pow(data.data.endY - data.data.startY, 2)
            );
            this.ctx.beginPath();
            this.ctx.arc(data.data.startX, data.data.startY, radius, 0, 2 * Math.PI);
            this.ctx.stroke();
            break;
          case 'arrow':
            this.drawArrow(this.ctx, data.data.startX, data.data.startY, data.data.endX, data.data.endY, false);
            break;
        }
        break;
        
      case 'clear':
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        break;
        
      case 'undo':
        if (this.drawingHistory.length > 1) {
          this.drawingHistory.pop();
          const previousState = this.drawingHistory[this.drawingHistory.length - 1];
          this.ctx.putImageData(previousState, 0, 0);
        }
        break;
    }
  }
}

function initAnnotationTools() {
  if (!annotationTool) {
    annotationTool = new AnnotationTool();
  }
}

function setupAnnotationToolEvents() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      if (annotationTool) {
        annotationTool.setTool(e.target.dataset.tool);
      }
    });
  });

  const colorPicker = document.getElementById('colorPicker');
  if (colorPicker) {
    colorPicker.addEventListener('change', (e) => {
      if (annotationTool) annotationTool.setColor(e.target.value);
    });
  }

  const brushSize = document.getElementById('brushSize');
  const brushSizeValue = document.getElementById('brushSizeValue');
  if (brushSize && brushSizeValue) {
    brushSize.addEventListener('input', (e) => {
      if (annotationTool) {
        annotationTool.setBrushSize(e.target.value);
        brushSizeValue.textContent = e.target.value + 'px';
      }
    });
  }

  const clearCanvas = document.getElementById('clearCanvas');
  if (clearCanvas) {
    clearCanvas.addEventListener('click', () => {
      if (annotationTool && confirm('Clear all drawings?')) {
        annotationTool.clearCanvas();
        broadcastDrawingAction('clear', {});
      }
    });
  }

  const undoDrawing = document.getElementById('undoDrawing');
  if (undoDrawing) {
    undoDrawing.addEventListener('click', () => {
      if (annotationTool) annotationTool.undo();
    });
  }
}

function broadcastDrawingAction(action, data) {
  if (socket) {
    socket.emit('drawing-action', {
      roomId,
      action,
      data,
      userId: socket.id,
      userName: username
    });
  }
}

// ===============================
//   CHAT FUNCTIONS
// ===============================
function addChatMessage(name, msg) {
  const chatMessages = document.getElementById("chatMessages");
  if (!chatMessages) return;

  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(msg)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ===============================
//   AI REPORT GENERATION
// ===============================
async function generateAIMedicalReport(imageData) {
  const mockReports = [
    "Chest X-ray shows clear lung fields with no evidence of consolidation or pleural effusion. The cardiomediastinal silhouette is within normal limits. No pneumothorax or focal opacities identified.",
    "Radiograph demonstrates mild peribronchial thickening with minimal hazy opacities in the lower lung zones. Heart size appears normal. Bony structures are intact without acute fracture.",
    "CT scan reveals bilateral ground-glass opacities predominantly in the peripheral lung zones. Mild interstitial thickening noted. No significant lymphadenopathy or pleural effusion.",
    "X-ray shows normal pulmonary vasculature and clear costophrenic angles. Diaphragmatic contours are smooth. No evidence of active pulmonary disease process.",
    "Imaging demonstrates patchy airspace opacities in the right middle and lower lobes. Small pleural effusion noted. Clinical correlation recommended for possible infectious process."
  ];

  await new Promise(resolve => setTimeout(resolve, 2000));
  return mockReports[Math.floor(Math.random() * mockReports.length)];
}

function updateAIDisplay(imageData, prediction, confidence, userName) {
  const aiResult = document.getElementById("aiResult");
  const aiImagePreview = document.getElementById("aiImagePreview");
  const analysisResults = document.getElementById("analysisResults");

  if (aiImagePreview) {
    aiImagePreview.src = imageData;
    aiImagePreview.style.display = "block";
  }
  
  if (analysisResults) analysisResults.style.display = "block";
  
  if (aiResult) {
    aiResult.innerHTML = `
      <div class="shared-by">Shared by: ${escapeHtml(userName)}</div>
      <div><strong>Prediction:</strong> ${escapeHtml(String(prediction))}</div>
      <div><strong>Confidence:</strong> ${Number(confidence).toFixed(4)}</div>
    `;
  }

  if (aiImagePreview) {
    aiImagePreview.onload = function() {
      if (annotationTool) annotationTool.resizeCanvasToImage();
    };
  }
}

function saveAnalysisResults(imageData, prediction, confidence) {
  localStorage.setItem('lastAnalysis', JSON.stringify({
    imageData,
    prediction,
    confidence,
    timestamp: Date.now()
  }));
}

function loadLastAnalysis() {
  const lastAnalysis = localStorage.getItem('lastAnalysis');
  if (lastAnalysis) {
    const analysis = JSON.parse(lastAnalysis);
    currentImageData = analysis.imageData;
    
    const analysisResults = document.getElementById("analysisResults");
    if (analysisResults) analysisResults.style.display = 'block';
    
    const aiImagePreview = document.getElementById('aiImagePreview');
    if (aiImagePreview) {
      aiImagePreview.src = currentImageData;
      aiImagePreview.style.display = 'block';
    }
    
    const aiResult = document.getElementById('aiResult');
    if (aiResult) {
      aiResult.innerHTML = `
        <div class="shared-by">Last Analysis</div>
        <div><strong>Prediction:</strong> ${escapeHtml(analysis.prediction)}</div>
        <div><strong>Confidence:</strong> ${analysis.confidence}</div>
      `;
    }
    
    initAnnotationTools();
    setTimeout(() => {
      if (annotationTool) annotationTool.resizeCanvasToImage();
    }, 100);
  }
}

// ===============================
//   PEER CONNECTION MANAGEMENT
// ===============================
function createPeerConnection(remoteId, isInitiator) {
  if (peers[remoteId]) return;

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        targetId: remoteId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    if (!remoteVideoElements[remoteId]) {
      const wrapper = document.createElement("div");
      wrapper.className = "remote-video-wrapper";
      wrapper.id = `video-${remoteId}`;

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.className = "remote-video";
      video.srcObject = event.streams[0];

      const participant = participants[remoteId];
      const label = document.createElement("div");
      label.textContent = participant ? `${participant.name} ${participant.isHost ? '👑' : ''}` : "Remote User";
      label.className = "video-label";

      wrapper.appendChild(video);
      wrapper.appendChild(label);

      document.getElementById("remoteVideos").appendChild(wrapper);
      remoteVideoElements[remoteId] = wrapper;
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      removePeer(remoteId);
    }
  };

  if (isInitiator) {
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", { offer, targetId: remoteId });
      } catch (err) {
        console.error("Failed to create offer:", err);
      }
    }, 1000);
  }
}

function removePeer(socketId) {
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  } 
  if (remoteVideoElements[socketId]) {
    remoteVideoElements[socketId].remove();
    delete remoteVideoElements[socketId];
  }
}

function escapeHtml(s) { 
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); 
}