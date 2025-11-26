// ===============================
//   MEDIZOOM - CLIENT LOGIC
// ===============================

// CONFIGURATION - CHANGE THIS URL WHEN NGROK RESTARTS
const AI_SERVER_URL = "https://santalaceous-catatonically-emile.ngrok-free.dev";

let socket = null;
let localStream = null;
let peers = {};
let remoteVideoElements = {};
let roomId = null;
let username = null;
let isHost = false;
let participants = {};

// ICE servers
const iceServers = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] }
  ]
};

// ===============================
//   PAGE DETECTION
// ===============================
document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "home") initHomePage();
  if (page === "room") initRoomPage();
});

// ===============================
//   HOME PAGE LOGIC
// ===============================
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

// ===============================
//   ROOM PAGE LOGIC
// ===============================
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
  setupAICollaboration();
  setupChat();
}

// ===============================
//   GET LOCAL CAMERA/MIC
// ===============================
async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    // Create local video element
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

    // Remove old local video if exists
    const existing = document.querySelector(".local-tile");
    if (existing) existing.remove();

    // Add to grid
    const grid = document.getElementById("remoteVideos");
    grid.appendChild(wrapper);

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
    console.log("Existing users:", userIds);
    userIds.forEach((id) => createPeerConnection(id, true));
  });

  socket.on("user-joined", ({ socketId, name, isHost: userIsHost }) => {
    console.log("User joined:", socketId, name);
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

  // Drawing events
  socket.on("drawing-action", (data) => {
    // Handle drawing if needed
  });

  // AI Report Updates
  socket.on("ai-report-update", ({ report, userName }) => {
    if (userName !== username) {
      const reportResult = document.getElementById("reportResult");
      reportResult.innerHTML = `
        <div class="shared-by">AI Medical Report (by ${userName})</div>
        <div>${report}</div>
      `;
      reportResult.className = "ai-report-result";
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
    console.log("Received offer from:", senderId);
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
    console.log("Received answer from:", senderId);
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
    console.log("User left:", socketId);
    removePeer(socketId);
    updateParticipantsList(participants);
  });

  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });

  // AI ANALYSIS BROADCAST
  socket.on("ai-analysis-update", ({ imageData, prediction, confidence, userName }) => {
    console.log("📥 Received AI analysis from:", userName);
    updateAIDisplay(imageData, prediction, confidence, userName);
    
    // Show notification in chat
    addChatMessage("System", `${userName} shared a medical image analysis: ${prediction} (${(confidence * 100).toFixed(1)}%)`);
  });
}

// ===============================
//   HOST CONTROLS
// ===============================
function updateHostUI() {
  const hostBadge = document.getElementById("hostBadge");
  const participantsList = document.getElementById("participantsList");
  
  if (hostBadge) {
    hostBadge.style.display = isHost ? "inline-block" : "none";
  }
  
  if (participantsList) {
    participantsList.innerHTML = generateParticipantsListHTML();
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
  
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// ===============================
//   AI COLLABORATION
// ===============================
function setupAICollaboration() {
  const aiForm = document.getElementById("aiForm");
  const aiFile = document.getElementById("aiFile");
  const generateReportBtn = document.getElementById("generateReportBtn");

  let currentImageData = null;

  // Main form handler
  aiForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = aiFile.files[0];
    if (!file) {
      const aiResult = document.getElementById("aiResult");
      if (aiResult) {
        aiResult.textContent = "Please choose an image file.";
      }
      return;
    }

    addChatMessage("System", `${username} is analyzing a medical image...`);

    const reader = new FileReader();
    reader.onload = async function(e) {
      currentImageData = e.target.result;
      
      // Show image preview
      const aiImagePreview = document.getElementById("aiImagePreview");
      if (aiImagePreview) {
        aiImagePreview.src = currentImageData;
        aiImagePreview.style.display = "block";
      }
      
      // Show analysis results section
      const aiAnalysisResults = document.getElementById("aiAnalysisResults");
      if (aiAnalysisResults) {
        aiAnalysisResults.style.display = "block";
      }
      
      const aiResult = document.getElementById("aiResult");
      if (aiResult) {
        aiResult.textContent = "Analyzing medical image...";
      }

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
            <div class="shared-by">Analysis Results</div>
            <div><strong>Prediction:</strong> ${escapeHtml(String(data.prediction))}</div>
            <div><strong>Confidence:</strong> ${Number(data.confidence).toFixed(4)}</div>
          `;
        }

        // Notify everyone in chat
        addChatMessage("System", `${username} shared AI analysis: ${data.prediction} (${(data.confidence * 100).toFixed(1)}%)`);

        // Broadcast to other participants
        socket.emit("ai-analysis-result", {
          roomId: roomId,
          imageData: currentImageData,
          prediction: data.prediction,
          confidence: data.confidence,
          userName: username
        });

      } catch (err) {
        console.error("AI analysis failed:", err);
        const aiResult = document.getElementById("aiResult");
        if (aiResult) {
          aiResult.textContent = "Error processing image. Please try again.";
        }
        addChatMessage("System", `${username}'s AI analysis failed.`);
      }
    };
    reader.readAsDataURL(file);
  });

  // Report AI Button Handler
  generateReportBtn.addEventListener("click", async () => {
    if (!currentImageData) {
      alert("Please analyze an image first.");
      return;
    }

    const reportLoading = document.getElementById("reportLoading");
    const reportResult = document.getElementById("reportResult");
    
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
        reportResult.className = "ai-report-result";
      }

      addChatMessage("System", `${username} generated an AI medical report.`);

      // Broadcast report to other participants
      socket.emit("ai-report-generated", {
        roomId: roomId,
        report: report,
        userName: username
      });

    } catch (error) {
      console.error("Report generation failed:", error);
      if (reportResult) {
        reportResult.innerHTML = "❌ Failed to generate report. Please try again.";
        reportResult.className = "ai-report-result report-error";
      }
    } finally {
      if (reportLoading) reportLoading.style.display = "none";
      generateReportBtn.disabled = false;
    }
  });
}

// AI Report Generation Function
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

  if (aiImagePreview) {
    aiImagePreview.src = imageData;
    aiImagePreview.style.display = "block";
  }
  
  if (aiResult) {
    aiResult.innerHTML = `
      <div class="shared-by">Shared by: ${escapeHtml(userName)}</div>
      <div><strong>Prediction:</strong> ${escapeHtml(String(prediction))}</div>
      <div><strong>Confidence:</strong> ${Number(confidence).toFixed(4)}</div>
    `;
  }
}

// ===============================
//   PARTICIPANTS MANAGEMENT
// ===============================
function updateParticipantsList(updatedParticipants) {
  participants = updatedParticipants;
  const participantsList = document.getElementById("participantsList");
  if (!participantsList) return;

  participantsList.innerHTML = generateParticipantsListHTML();
}

function updateVideoLabels() {
  // Update local video label
  const localVideo = document.querySelector('.local-tile .video-label');
  if (localVideo) {
    localVideo.textContent = `${username} (You) ${isHost ? '👑' : ''}`;
  }

  // Update remote video labels
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
//   PEER CONNECTION MANAGEMENT
// ===============================
function createPeerConnection(remoteId, isInitiator) {
  if (peers[remoteId]) return;

  console.log("Creating peer connection with:", remoteId, "initiator:", isInitiator);

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId] = pc;

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        targetId: remoteId,
        candidate: event.candidate
      });
    }
  };

  // Handle remote stream
  pc.ontrack = (event) => {
    console.log("Received remote track from:", remoteId);
    
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

  // Handle connection state
  pc.onconnectionstatechange = () => {
    console.log(`Connection state with ${remoteId}:`, pc.connectionState);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      removePeer(remoteId);
    }
  };

  // Create offer if initiator
  if (isInitiator) {
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", {
          offer,
          targetId: remoteId
        });
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

// ===============================
//   CHAT FUNCTIONALITY
// ===============================
function setupChat() {
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

function addChatMessage(name, msg) {
  const chatMessages = document.getElementById("chatMessages");
  if (!chatMessages) return;

  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(msg)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(s) { 
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); 
}

// ===============================
//   CONTROLS
// ===============================
function setupControls() {
  const btnMic = document.getElementById("btnToggleMic");
  const btnCam = document.getElementById("btnToggleCamera");
  const btnScreen = document.getElementById("btnShareScreen");
  const btnLeave = document.getElementById("btnLeave");

  if (btnMic) {
    btnMic.addEventListener("click", () => {
      const audioTrack = localStream?.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        btnMic.textContent = audioTrack.enabled ? "🎙️ Mute" : "🔇 Unmute";
        
        // Update participant state
        if (participants[socket.id]) {
          participants[socket.id].isMuted = !audioTrack.enabled;
        }
      }
    });
  }

  if (btnCam) {
    btnCam.addEventListener("click", () => {
      const videoTrack = localStream?.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        btnCam.textContent = videoTrack.enabled ? "📷 Camera Off" : "📷 Camera On";
        
        // Update participant state
        if (participants[socket.id]) {
          participants[socket.id].isVideoOn = videoTrack.enabled;
        }
      }
    });
  }

  if (btnScreen) {
    btnScreen.addEventListener("click", async () => {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        // Replace video track for all peers
        for (const id in peers) {
          const sender = peers[id].getSenders().find(s => s.track?.kind === "video");
          if (sender) sender.replaceTrack(screenTrack);
        }

        // Revert to camera when screen sharing stops
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
  }

  if (btnLeave) {
    btnLeave.addEventListener("click", () => {
      if (socket) socket.disconnect();
      if (localStream) localStream.getTracks().forEach(track => track.stop());
      window.location.href = "index.html";
    });
  }
}