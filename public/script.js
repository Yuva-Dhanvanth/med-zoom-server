// ===============================
//   MINI ZOOM - CLIENT LOGIC (fixed)
// ===============================

let socket = null;
let localStream = null;
let peers = {};               // socketId -> RTCPeerConnection
let remoteVideoElements = {}; // socketId -> video element
let roomId = null;
let username = null;

// ICE servers
const iceServers = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" }
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

    // quick permissions test
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
  // Get URL params
  const params = new URLSearchParams(window.location.search);
  roomId = params.get("room");
  username = params.get("name") || "Guest";

  document.getElementById("roomLabel").textContent = roomId;
  document.getElementById("usernameLabel").textContent = username;

  // Initialize socket
  socket = io();

  registerSocketEvents();

  // Get camera + mic
  await initLocalMedia();

  // Join room on server
  socket.emit("join-room", { roomId, name: username });

  // UI controls
  setupControls();
  
  // Initialize AI collaboration
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

    // Wrapper (same as remote tiles)
    const wrapper = document.createElement("div");
    wrapper.className = "remote-video-wrapper local-tile";

    // Video element
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;         // VERY IMPORTANT
    video.srcObject = localStream;
    video.className = "remote-video";

    // Label
    const label = document.createElement("div");
    label.textContent = "You";
    label.className = "video-label";

    wrapper.appendChild(video);
    wrapper.appendChild(label);

    // ⛔ REMOVE OLD LOCAL VIDEO TILE (if reloading)
    const existing = document.querySelector(".local-tile");
    if (existing) existing.remove();

    // ✅ Insert local video FIRST for proper grid layout
    const grid = document.getElementById("remoteVideos");
    grid.insertBefore(wrapper, grid.firstChild);

  } catch (err) {
    console.error("Media error:", err);
    alert("Unable to access camera/microphone.");
  }
}

// ===============================
//   SOCKET.IO EVENTS (fixed)
// ===============================
function registerSocketEvents() {

  // List of existing users when we join (this event is emitted only to the newly-joined client)
  socket.on("existing-users", (userIds) => {
    console.log("Existing users (new client):", userIds);
    // The NEW client should create offers to existing users
    if (!Array.isArray(userIds) || userIds.length === 0) return;
    userIds.forEach((id) => createPeerConnection(id, true)); // this side initiates the offer
  });

  // A new user joined (broadcast to existing clients) — existing clients should NOT initiate offers
  socket.on("user-joined", ({ socketId }) => {
    console.log("New user joined (other clients notified):", socketId);
    // Prepare a peer connection to accept an offer from the newcomer (answerer), but DON'T create an offer.
    createPeerConnection(socketId, false);
  });

  // Receive offer -> we must answer
  socket.on("offer", async ({ offer, senderId }) => {
    console.log("Received offer from", senderId);

    // Ensure we have a peer object
    if (!peers[senderId]) {
      createPeerConnection(senderId, false); // become answerer
    }

    try {
      await peers[senderId].setRemoteDescription(new RTCSessionDescription(offer));
    } catch (err) {
      console.warn("setRemoteDescription (offer) failed:", err);
      return;
    }

    try {
      const answer = await peers[senderId].createAnswer();
      await peers[senderId].setLocalDescription(answer);

      socket.emit("answer", {
        answer,
        targetId: senderId
      });
    } catch (err) {
      console.error("Failed to create/send answer:", err);
    }
  });

  // Receive answer -> attach as remote description (only initiator receives an answer)
  socket.on("answer", async ({ answer, senderId }) => {
    console.log("Received answer from", senderId);
    const pc = peers[senderId];
    if (!pc) {
      console.warn("No RTCPeerConnection for senderId (answer). Ignoring.");
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.warn("setRemoteDescription (answer) failed:", err);
    }
  });

  // ICE candidate
  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    if (peers[senderId]) {
      try {
        await peers[senderId].addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("ICE add failed", e);
      }
    }
  });

  // A user left
  socket.on("user-left", (socketId) => {
    console.log("User left:", socketId);
    removePeer(socketId);
  });

  // Chat message
  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });

  // AI ANALYSIS BROADCAST - NEW EVENT
  socket.on("ai-analysis-update", ({ imageData, prediction, confidence, userName }) => {
    console.log("📥 Received AI analysis from:", userName);
    updateAIDisplay(imageData, prediction, confidence, userName);
    
    // Show notification in chat
    const chatMessages = document.getElementById("chatMessages");
    if (chatMessages) {
      const notification = document.createElement("div");
      notification.className = "chat-msg";
      notification.innerHTML = `🔬 <strong>${escapeHtml(userName)}</strong> shared a medical image analysis: <strong>${escapeHtml(prediction)}</strong> (${(confidence * 100).toFixed(1)}%)`;
      chatMessages.appendChild(notification);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  });

  // (Optional) participants list update
  socket.on("room-users", (usersObj) => {
    // you can implement participant list rendering here later
    // console.log("room-users:", usersObj);
  });
}

// ===============================
//   COLLABORATIVE AI ANALYSIS - FIXED
// ===============================
function setupAICollaboration() {
  const aiForm = document.getElementById("aiForm");
  const aiFile = document.getElementById("aiFile");
  const aiResult = document.getElementById("aiResult");
  const aiImagePreview = document.getElementById("aiImagePreview");

  if (!aiForm || !aiFile || !aiResult || !aiImagePreview) return;

  aiForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const file = aiFile.files[0];
    if (!file) {
      aiResult.textContent = "Please choose an image file.";
      return;
    }

    // ✅ USE LOCAL PREVIEW ONLY - NO SERVER IMAGE LOADING
    const reader = new FileReader();
    reader.onload = async function(e) {
      const imageData = e.target.result; // data:image/png;base64,...
      
      // Show local preview immediately
      aiImagePreview.src = imageData;
      aiImagePreview.style.display = "block";
      aiResult.textContent = "Analyzing...";

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch('https://santalaceous-catatonically-emile.ngrok-free.dev/predict', {
          method: "POST",
          body: formData,
          headers: {
            'ngrok-skip-browser-warning': 'true'
          }
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Server error (${res.status}): ${text}`);
        }

        const data = await res.json();

        if (!data || !data.prediction) {
          aiResult.textContent = "Invalid response from AI server.";
          return;
        }

        aiResult.innerHTML = `
          <div class="shared-by">Shared by: You</div>
          <div><strong>Prediction:</strong> ${escapeHtml(String(data.prediction))}</div>
          <div><strong>Confidence:</strong> ${Number(data.confidence).toFixed(4)}</div>
          <div style="margin-top: 8px; font-size: 0.8em; color: var(--text-muted);">
            🔄 Shared with all participants
          </div>
        `;

        // ✅ BROADCAST TO EVERYONE IN THE ROOM
        socket.emit("ai-analysis-result", {
          roomId: roomId,
          imageData: imageData,
          prediction: data.prediction,
          confidence: data.confidence,
          userName: username
        });

        console.log("📤 Analysis shared with room");

      } catch (err) {
        console.error("AI upload failed:", err);
        aiResult.textContent = "Error while processing the image.";
      }
    };
    reader.readAsDataURL(file); // This creates local data URL
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
//   CREATE A PEER CONNECTION
// ===============================
function createPeerConnection(remoteId, isInitiator) {
  // avoid duplicates
  if (peers[remoteId]) return;

  console.log("Creating peer:", remoteId, "initiator?", isInitiator);

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId] = pc;
  peers[remoteId].username = remoteId;

  // Add local tracks (if localStream is available)
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  // ICE CANDIDATES -> forward to server
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        targetId: remoteId,
        candidate: event.candidate
      });
    }
  };

  // REMOTE STREAM handling
  // REMOTE STREAM handler (FIXED for equal grid)
  pc.ontrack = (event) => {
    if (!remoteVideoElements[remoteId]) {

      // Wrapper so CSS grid works properly
      const wrapper = document.createElement("div");
      wrapper.className = "remote-video-wrapper";

      // Video element
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.className = "remote-video";
      video.srcObject = event.streams[0];

      // Label for remote user
      const label = document.createElement("div");
      label.textContent = peers[remoteId]?.username || "Guest";
      label.className = "video-label";

      wrapper.appendChild(video);
      wrapper.appendChild(label);

      document.getElementById("remoteVideos").appendChild(wrapper);

      remoteVideoElements[remoteId] = wrapper;
    } else {
      // Update video stream if needed
      const videoEl = remoteVideoElements[remoteId].querySelector("video");
      if (videoEl) videoEl.srcObject = event.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    console.log("Connection state with", remoteId, ":", pc.connectionState);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      removePeer(remoteId);
    }
  };

  // if this side is initiator -> create offer
  if (isInitiator) {
    // small delay to allow handler setup on remote side (helps reduce race conditions)
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("offer", {
          offer,
          targetId: remoteId
        });
      } catch (err) {
        console.error("Failed to create/send offer:", err);
      }
    }, 200);
  }
}

// ===============================
//   REMOVE PEER WHEN USER LEAVES
// ===============================
function removePeer(socketId) {
  if (peers[socketId]) {
    try { peers[socketId].close(); } catch (e) {}
    delete peers[socketId];
  }

  if (remoteVideoElements[socketId]) {
    try { remoteVideoElements[socketId].remove(); } catch (e) {}
    delete remoteVideoElements[socketId];
  }
}

// ===============================
//   CHAT
// ===============================
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");

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

function addChatMessage(name, msg) {
  if (!chatMessages) return;
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(msg)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ===============================
//   CONTROLS (MUTE, CAMERA, SCREEN)
// ===============================
function setupControls() {
  const btnMic = document.getElementById("btnToggleMic");
  const btnCam = document.getElementById("btnToggleCamera");
  const btnScreen = document.getElementById("btnShareScreen");
  const btnLeave = document.getElementById("btnLeave");

  if (btnMic) {
    btnMic.addEventListener("click", () => {
      const audioTrack = localStream && localStream.getAudioTracks()[0];
      if (!audioTrack) return;
      audioTrack.enabled = !audioTrack.enabled;
      btnMic.textContent = audioTrack.enabled ? "🎙️ Mute" : "🔇 Unmute";
    });
  }

  if (btnCam) {
    btnCam.addEventListener("click", () => {
      const videoTrack = localStream && localStream.getVideoTracks()[0];
      if (!videoTrack) return;
      videoTrack.enabled = !videoTrack.enabled;
      btnCam.textContent = videoTrack.enabled ? "📷 Camera Off" : "📷 Camera On";
    });
  }

  if (btnScreen) {
    btnScreen.addEventListener("click", async () => {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        // Replace track for all peers
        for (const id in peers) {
          const sender = peers[id].getSenders().find(s => s.track && s.track.kind === "video");
          if (sender) sender.replaceTrack(screenTrack);
        }

        // When user stops screen share, revert to camera
        screenTrack.onended = () => {
          const cameraTrack = localStream && localStream.getVideoTracks()[0];
          for (const id in peers) {
            const sender = peers[id].getSenders().find(s => s.track && s.track.kind === "video");
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
      // Disconnect socket
      if (socket) {
        socket.disconnect();
      }
      // Stop all media tracks
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
      // Redirect to home page
      window.location.href = "index.html";
    });
  }
}

// ===============================
//   POPUP MANAGEMENT
// ===============================

function setupPopups() {
  const btnParticipants = document.getElementById("btnParticipants");
  const btnAskAI = document.getElementById("btnAskAI");
  const closeParticipantsPopup = document.getElementById("closeParticipantsPopup");
  const closeAIPopup = document.getElementById("closeAIPopup");
  const participantsPopup = document.getElementById("participantsPopup");
  const aiPopup = document.getElementById("aiPopup");

  // Participants popup
  btnParticipants.addEventListener("click", () => {
    participantsPopup.style.display = "flex";
    updateParticipantsList();
  });

  closeParticipantsPopup.addEventListener("click", () => {
    participantsPopup.style.display = "none";
  });

  // AI popup
  btnAskAI.addEventListener("click", () => {
    aiPopup.style.display = "flex";
    // Reset AI form when opening
    document.getElementById("aiFile").value = "";
    document.getElementById("aiResult").textContent = "";
    document.getElementById("aiImagePreview").style.display = "none";
  });

  closeAIPopup.addEventListener("click", () => {
    aiPopup.style.display = "none";
  });

  // Close popups when clicking outside
  [participantsPopup, aiPopup].forEach(popup => {
    popup.addEventListener("click", (e) => {
      if (e.target === popup) {
        popup.style.display = "none";
      }
    });
  });
}

function updateParticipantsList() {
  const participantsList = document.getElementById("participantsList");
  if (!participantsList) return;

  // For now, we'll just show current user
  // You can expand this later with socket.io room users
  participantsList.innerHTML = `
    <div class="participant-item">
      <div class="participant-avatar">${username.charAt(0).toUpperCase()}</div>
      <div class="participant-name">${username} (You)</div>
    </div>
  `;
}

// ===============================
//   MODIFIED AI COLLABORATION FOR POPUP
// ===============================

function setupAICollaboration() {
  const aiForm = document.getElementById("aiForm");
  const aiFile = document.getElementById("aiFile");
  const aiResult = document.getElementById("aiResult");
  const aiImagePreview = document.getElementById("aiImagePreview");

  if (!aiForm || !aiFile || !aiResult || !aiImagePreview) return;

  aiForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const file = aiFile.files[0];
    if (!file) {
      aiResult.textContent = "Please choose an image file.";
      return;
    }

    // Convert to data URL for sharing with other participants
    const reader = new FileReader();
    reader.onload = async function(e) {
      const imageData = e.target.result; // data:image/png;base64,...
      
      // Show local preview immediately
      aiImagePreview.src = imageData;
      aiImagePreview.style.display = "block";
      aiResult.textContent = "Analyzing...";

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch('https://santalaceous-catatonically-emile.ngrok-free.dev/predict', {
          method: "POST",
          body: formData,
          headers: {
            'ngrok-skip-browser-warning': 'true'
          }
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Server error (${res.status}): ${text}`);
        }

        const data = await res.json();

        if (!data || !data.prediction) {
          aiResult.textContent = "Invalid response from AI server.";
          return;
        }

        aiResult.innerHTML = `
          <div class="shared-by">Shared by: You</div>
          <div><strong>Prediction:</strong> ${escapeHtml(String(data.prediction))}</div>
          <div><strong>Confidence:</strong> ${Number(data.confidence).toFixed(4)}</div>
          <div style="margin-top: 8px; font-size: 0.8em; color: var(--text-muted);">
            🔄 Shared with all participants
          </div>
        `;

        // ✅ BROADCAST TO EVERYONE IN THE ROOM
        socket.emit("ai-analysis-result", {
          roomId: roomId,
          imageData: imageData,
          prediction: data.prediction,
          confidence: data.confidence,
          userName: username
        });

        console.log("📤 Analysis shared with room");

      } catch (err) {
        console.error("AI upload failed:", err);
        aiResult.textContent = "Error while processing the image.";
      }
    };
    reader.readAsDataURL(file);
  });
}

function updateAIDisplay(imageData, prediction, confidence, userName) {
  const aiResult = document.getElementById("aiResult");
  const aiImagePreview = document.getElementById("aiImagePreview");

  // Update the popup if it's open
  aiImagePreview.src = imageData;
  aiImagePreview.style.display = "block";
  
  aiResult.innerHTML = `
    <div class="shared-by">Shared by: ${escapeHtml(userName)}</div>
    <div><strong>Prediction:</strong> ${escapeHtml(String(prediction))}</div>
    <div><strong>Confidence:</strong> ${Number(confidence).toFixed(4)}</div>
  `;

  // Also show notification in chat
  const chatMessages = document.getElementById("chatMessages");
  if (chatMessages) {
    const notification = document.createElement("div");
    notification.className = "chat-msg";
    notification.innerHTML = `🔬 <strong>${escapeHtml(userName)}</strong> shared a medical image analysis: <strong>${escapeHtml(prediction)}</strong> (${(confidence * 100).toFixed(1)}%)`;
    chatMessages.appendChild(notification);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}