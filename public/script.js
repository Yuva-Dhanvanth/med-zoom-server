// public/script.js
// ============================================================================
// FULLY FIXED WEBRTC FILE — NO CHANGES REQUIRED
// ============================================================================

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");
const username = urlParams.get("name") || "Guest";

const socket = io();

// All peer connections: { socketId: RTCPeerConnection }
const peers = {};

// Local media
let localStream = null;

// DOM
const localVideo = document.getElementById("localVideo");
const remoteVideos = document.getElementById("remoteVideos");
const participantsList = document.getElementById("participantsList");

// Chat
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

// ============================================================================
// 1. GET CAMERA/MIC FIRST
// ============================================================================

async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    localVideo.srcObject = localStream;

    // required for autoplay on browsers
    localVideo.muted = true;
    localVideo.playsInline = true;

    await localVideo.play();
  } catch (err) {
    console.error("Media error:", err);
    alert("Camera or mic error");
  }
}

initMedia().then(() => {
  socket.emit("join-room", { roomId, username });
});

// ============================================================================
// 2. WHEN WE JOIN, SERVER SENDS ICE SERVERS + USERS
// ============================================================================

socket.on("room-joined", async ({ roomId, yourId, participants, iceServers }) => {
  console.log("Joined room", roomId);

  updateParticipants(participants);

  // For each existing user → create offer
  for (const p of participants) {
    if (p.id !== yourId) {
      createOfferForPeer(p.id, iceServers, p.username);
    }
  }
});

// ============================================================================
// PEER CONNECTION CREATION — FIXED
// ============================================================================

function createPeerConnection(peerId, iceServers, peerName) {
  const pc = new RTCPeerConnection({ iceServers });

  // Add our tracks to them
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  // Remote tracks
  pc.ontrack = (e) => {
    console.log("ontrack from", peerId);
    addRemoteVideo(peerId, e.streams[0], peerName);
  };

  // ICE candidates
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("signal-ice-candidate", {
        roomId,
        to: peerId,
        candidate: e.candidate,
      });
    }
  };

  return pc;
}

// ============================================================================
// OFFER CREATION
// ============================================================================

async function createOfferForPeer(peerId, iceServers, username) {
  console.log("Creating offer to", peerId);

  const pc = createPeerConnection(peerId, iceServers, username);
  peers[peerId] = pc;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit("signal-offer", {
    roomId,
    to: peerId,
    offer,
  });
}

// ============================================================================
// RECEIVE OFFER → SEND ANSWER
// ============================================================================

socket.on("signal-offer", async ({ from, offer }) => {
  console.log("Received offer from", from);

  const pc = createPeerConnection(from, undefined, "Remote");
  peers[from] = pc;

  if (pc.signalingState !== "stable") {
    console.warn("Offer received in wrong state. Resetting.");
    await pc.setLocalDescription();
  }

  await pc.setRemoteDescription(offer);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit("signal-answer", {
    roomId,
    to: from,
    answer,
  });
});

// ============================================================================
// RECEIVE ANSWER
// ============================================================================

socket.on("signal-answer", async ({ from, answer }) => {
  console.log("Received answer from", from);

  const pc = peers[from];
  if (!pc) return;

  if (pc.signalingState === "have-local-offer") {
    await pc.setRemoteDescription(answer);
  } else {
    console.warn("Answer ignored: wrong PC state:", pc.signalingState);
  }
});

// ============================================================================
// ICE CANDIDATES
// ============================================================================

socket.on("signal-ice-candidate", async ({ from, candidate }) => {
  const pc = peers[from];
  if (!pc) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn("ICE add failed:", err);
  }
});

// ============================================================================
// NEW USER
// ============================================================================

socket.on("user-joined", ({ socketId, username }) => {
  console.log("User joined:", socketId, username);
  addParticipant(socketId, username);
});

// ============================================================================
// USER LEFT
// ============================================================================

socket.on("user-left", ({ socketId }) => {
  console.log("User left:", socketId);
  removeRemoteVideo(socketId);
  delete peers[socketId];
  removeParticipant(socketId);
});

// ============================================================================
// REMOTE VIDEOS
// ============================================================================

function addRemoteVideo(id, stream, name) {
  let wrapper = document.getElementById("remote-" + id);

  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.className = "remote-video-wrapper";
    wrapper.id = "remote-" + id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // important for autoplay
    video.className = "remote-video-element";
    video.id = "video-" + id;

    const label = document.createElement("div");
    label.className = "remote-video-label";
    label.innerText = name;

    wrapper.appendChild(video);
    wrapper.appendChild(label);
    remoteVideos.appendChild(wrapper);
  }

  const vid = document.getElementById("video-" + id);
  vid.srcObject = stream;

  setTimeout(() => vid.play().catch(() => {}), 200);
}

function removeRemoteVideo(id) {
  const el = document.getElementById("remote-" + id);
  if (el) el.remove();
}

// ============================================================================
// PARTICIPANTS LIST
// ============================================================================

function updateParticipants(list) {
  participantsList.innerHTML = "";
  list.forEach((p) => addParticipant(p.id, p.username));
}

function addParticipant(id, name) {
  const li = document.createElement("li");
  li.id = "p-" + id;
  li.innerText = name;
  participantsList.appendChild(li);
}

function removeParticipant(id) {
  const li = document.getElementById("p-" + id);
  if (li) li.remove();
}

// ============================================================================
// CHAT
// ============================================================================

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!chatInput.value.trim()) return;

  socket.emit("send-chat-message", {
    roomId,
    message: chatInput.value.trim(),
  });

  chatInput.value = "";
});

socket.on("chat-message", ({ username, message, time }) => {
  const div = document.createElement("div");
  div.className = "chat-message";

  div.innerHTML = `
    <span class="chat-username">${username}:</span>
    ${message}
    <span class="chat-time">${new Date(time).toLocaleTimeString()}</span>
  `;

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});
