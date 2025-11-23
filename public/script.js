// ===============================
//   MINI ZOOM - CLIENT LOGIC
// ===============================

let socket = null;
let localStream = null;
let peers = {};
let remoteVideoElements = {};
let roomId = null;
let username = null;
let isPopupInitiator = false;

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
  setupPopups();
  setupAICollaboration();
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
    label.textContent = "You";
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
  socket.on("existing-users", (userIds) => {
    console.log("Existing users:", userIds);
    userIds.forEach((id) => createPeerConnection(id, true));
  });

  socket.on("user-joined", ({ socketId, name }) => {
    console.log("User joined:", socketId, name);
    createPeerConnection(socketId, false);
  });

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
  });

  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });

  socket.on("room-users", (users) => {
    updateParticipantsList(users);
  });

  // AI ANALYSIS BROADCAST
  socket.on("ai-analysis-update", ({ imageData, prediction, confidence, userName }) => {
    console.log("📥 Received AI analysis from:", userName);
    updateAIDisplay(imageData, prediction, confidence, userName);
    
    // Show notification in chat
    addChatMessage("System", `${userName} shared a medical image analysis: ${prediction} (${(confidence * 100).toFixed(1)}%)`);
  });

  // SHARED POPUP EVENTS
  socket.on("ai-popup-opened", ({ userName }) => {
    console.log(`📢 ${userName} opened AI popup`);
    openAIPopupAsViewer(userName);
  });

  socket.on("ai-popup-closed", ({ userName }) => {
    console.log(`📢 ${userName} closed AI popup`);
    closeAIPopupAsViewer();
  });

  // AI ANALYSIS STATUS
  socket.on("ai-analysis-status", ({ userName, status, message }) => {
    const aiResult = document.getElementById("aiResult");
    if (aiResult && status === "analyzing") {
      aiResult.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 20px;">
          <div style="font-size: 2rem; margin-bottom: 10px;">🔬</div>
          <div><strong>${userName}</strong> is analyzing a medical image</div>
          <div style="font-size: 0.9rem; margin-top: 8px;">${message}</div>
        </div>
      `;
    }
  });
}

// ===============================
//   POPUP MANAGEMENT - FIXED
// ===============================
function setupPopups() {
  const btnParticipants = document.getElementById("btnParticipants");
  const btnAskAI = document.getElementById("btnAskAI");
  const closeParticipantsPopup = document.getElementById("closeParticipantsPopup");
  const closeAIPopup = document.getElementById("closeAIPopup");
  const participantsPopup = document.getElementById("participantsPopup");
  const aiPopup = document.getElementById("aiPopup");
  const aiForm = document.getElementById("aiForm");

  // Participants popup (local only)
  btnParticipants.addEventListener("click", () => {
    participantsPopup.style.display = "flex";
  });

  closeParticipantsPopup.addEventListener("click", () => {
    participantsPopup.style.display = "none";
  });

  // AI popup (shared with everyone)
  btnAskAI.addEventListener("click", () => {
    openAIPopupAsInitiator();
  });

  closeAIPopup.addEventListener("click", () => {
    if (isPopupInitiator) {
      closeAIPopupAsInitiator();
    } else {
      closeAIPopupAsViewer();
    }
  });

  // Close popups when clicking outside
  [participantsPopup, aiPopup].forEach(popup => {
    popup.addEventListener("click", (e) => {
      if (e.target === popup) {
        if (popup === aiPopup) {
          if (isPopupInitiator) {
            closeAIPopupAsInitiator();
          } else {
            closeAIPopupAsViewer();
          }
        } else {
          popup.style.display = "none";
        }
      }
    });
  });
}

function openAIPopupAsInitiator() {
  const aiPopup = document.getElementById("aiPopup");
  const aiForm = document.getElementById("aiForm");
  
  isPopupInitiator = true;
  aiPopup.style.display = "flex";
  
  // Show upload form for initiator
  if (aiForm) aiForm.style.display = "block";
  
  // Reset form
  document.getElementById("aiFile").value = "";
  document.getElementById("aiResult").textContent = "";
  document.getElementById("aiImagePreview").style.display = "none";
  
  // Notify everyone that AI popup was opened
  socket.emit("open-ai-popup", {
    roomId: roomId,
    userName: username
  });
}

function openAIPopupAsViewer(userName) {
  const aiPopup = document.getElementById("aiPopup");
  const aiForm = document.getElementById("aiForm");
  const aiResult = document.getElementById("aiResult");
  
  isPopupInitiator = false;
  aiPopup.style.display = "flex";
  
  // Hide upload form for viewers
  if (aiForm) aiForm.style.display = "none";
  
  // Show viewer message
  if (aiResult) {
    aiResult.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 20px;">
        <div style="font-size: 2rem; margin-bottom: 10px;">🩺</div>
        <div><strong>${userName}</strong> is analyzing a medical image</div>
        <div style="font-size: 0.9rem; margin-top: 8px;">Waiting for analysis results...</div>
      </div>
    `;
  }
  
  // Clear any previous image
  const aiImagePreview = document.getElementById("aiImagePreview");
  if (aiImagePreview) {
    aiImagePreview.style.display = "none";
    aiImagePreview.src = "";
  }
}

function closeAIPopupAsInitiator() {
  const aiPopup = document.getElementById("aiPopup");
  aiPopup.style.display = "none";
  
  // Reset state
  isPopupInitiator = false;
  
  // Notify everyone that AI popup was closed
  socket.emit("close-ai-popup", {
    roomId: roomId,
    userName: username
  });
}

function closeAIPopupAsViewer() {
  const aiPopup = document.getElementById("aiPopup");
  aiPopup.style.display = "none";
  
  // Only reset local state, don't broadcast
  isPopupInitiator = false;
}

function updateParticipantsList(users) {
  const participantsList = document.getElementById("participantsList");
  if (!participantsList) return;

  let html = '';
  for (const [socketId, name] of Object.entries(users)) {
    const isYou = socketId === socket.id;
    html += `
      <div class="participant-item">
        <div class="participant-avatar">${name.charAt(0).toUpperCase()}</div>
        <div class="participant-name">${name} ${isYou ? '(You)' : ''}</div>
      </div>
    `;
  }
  participantsList.innerHTML = html;
}

// ===============================
//   AI COLLABORATION
// ===============================
function setupAICollaboration() {
  const aiForm = document.getElementById("aiForm");
  const aiFile = document.getElementById("aiFile");
  const aiResult = document.getElementById("aiResult");
  const aiImagePreview = document.getElementById("aiImagePreview");

  aiForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = aiFile.files[0];
    if (!file) {
      aiResult.textContent = "Please choose an image file.";
      return;
    }

    // Show analyzing message to everyone immediately
    socket.emit("ai-analysis-start", {
      roomId: roomId,
      userName: username
    });

    // Convert to data URL for preview and sharing
    const reader = new FileReader();
    reader.onload = async function(e) {
      const imageData = e.target.result;
      
      // Show local preview immediately
      aiImagePreview.src = imageData;
      aiImagePreview.style.display = "block";
      aiResult.textContent = "Analyzing medical image...";

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch('https://santalaceous-catatonically-emile.ngrok-free.dev/predict', {
          method: "POST",
          body: formData,
          headers: { 'ngrok-skip-browser-warning': 'true' }
        });

        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        
        const data = await res.json();
        if (!data?.prediction) throw new Error("Invalid response from AI server");

        // Show results
        aiResult.innerHTML = `
          <div class="shared-by">Shared by: You</div>
          <div><strong>Prediction:</strong> ${escapeHtml(String(data.prediction))}</div>
          <div><strong>Confidence:</strong> ${Number(data.confidence).toFixed(4)}</div>
        `;

        // Broadcast to all participants
        socket.emit("ai-analysis-result", {
          roomId: roomId,
          imageData: imageData,
          prediction: data.prediction,
          confidence: data.confidence,
          userName: username
        });

      } catch (err) {
        console.error("AI analysis failed:", err);
        aiResult.textContent = "Error processing image. Please try again.";
        
        // Notify everyone about the error
        socket.emit("ai-analysis-error", {
          roomId: roomId,
          userName: username,
          error: err.message
        });
      }
    };
    reader.readAsDataURL(file);
  });
}

function updateAIDisplay(imageData, prediction, confidence, userName) {
  const aiResult = document.getElementById("aiResult");
  const aiImagePreview = document.getElementById("aiImagePreview");

  aiImagePreview.src = imageData;
  aiImagePreview.style.display = "block";
  
  aiResult.innerHTML = `
    <div class="shared-by">Shared by: ${escapeHtml(userName)}</div>
    <div><strong>Prediction:</strong> ${escapeHtml(String(prediction))}</div>
    <div><strong>Confidence:</strong> ${Number(confidence).toFixed(4)}</div>
  `;
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

      const label = document.createElement("div");
      label.textContent = "Remote User";
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
//   CHAT
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
      }
    });
  }

  if (btnCam) {
    btnCam.addEventListener("click", () => {
      const videoTrack = localStream?.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        btnCam.textContent = videoTrack.enabled ? "📷 Camera Off" : "📷 Camera On";
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