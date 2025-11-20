// public/script.js
// ============================================================================
// ONE FILE for both pages:
//
// - index.html  -> home page (enter room + name)
// - room.html   -> meeting page (video, audio, chat, screen share)
//
// This version focuses on making sure that:
//
// - Local audio/video is sent correctly.
// - Remote audio/video is received and actually played.
// - TURN/STUN from the server is used for connections.
// ============================================================================

(function () {
  const page = document.body.dataset.page;

  if (page === "home") {
    initHomePage();
  } else if (page === "room") {
    initRoomPage();
  }

  // ============================= HOME PAGE ==================================
  function initHomePage() {
    const form = document.getElementById("joinForm");
    const roomInput = document.getElementById("roomInput");
    const nameInput = document.getElementById("nameInput");
    const errorEl = document.getElementById("homeError");

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const roomId = roomInput.value.trim();
      const name = nameInput.value.trim();

      if (!roomId) {
        errorEl.textContent = "Please enter a room number.";
        return;
      }

      errorEl.textContent = "";

      const displayName = name || `Guest-${Math.floor(Math.random() * 10000)}`;

      const url = `room.html?room=${encodeURIComponent(
        roomId
      )}&name=${encodeURIComponent(displayName)}`;
      window.location.href = url;
    });
  }

  // ============================ MEETING PAGE ================================
  function initRoomPage() {
    // ----- DOM elements -----
    const roomLabel = document.getElementById("roomLabel");
    const usernameLabel = document.getElementById("usernameLabel");
    const localVideo = document.getElementById("localVideo");
    const remoteVideosContainer = document.getElementById("remoteVideos");
    const participantsList = document.getElementById("participantsList");

    const btnToggleMic = document.getElementById("btnToggleMic");
    const btnToggleCamera = document.getElementById("btnToggleCamera");
    const btnShareScreen = document.getElementById("btnShareScreen");

    const chatMessages = document.getElementById("chatMessages");
    const chatForm = document.getElementById("chatForm");
    const chatInput = document.getElementById("chatInput");

    // ----- Room / username from URL -----
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get("room") || "unknown";
    let username =
      params.get("name") || `Guest-${Math.floor(Math.random() * 10000)}`;

    roomLabel.textContent = roomId;
    usernameLabel.textContent = username;

    // ----- WebRTC and signaling state -----
    let socket = null;
    let localStream = null;
    let screenStream = null;

    let isAudioEnabled = true;
    let isVideoEnabled = true;
    let isScreenSharing = false;

    let iceServersFromServer = [];

    const peerConnections = {}; // peerId -> RTCPeerConnection
    const remoteVideoElements = {}; // peerId -> wrapper div
    const participants = {}; // peerId -> username

    // Start it all
    start();

    // ------------------------------------------------------------------------
    // Main start: get media, connect socket, join room
    // ------------------------------------------------------------------------
    async function start() {
      try {
        // 1. Ask for camera + mic
        localStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        // Show local stream in our video element
        localVideo.srcObject = localStream;
        localVideo.muted = true; // avoid hearing our own voice locally

        // 2. Connect to signaling server (Socket.IO)
        socket = io();

        // 3. Set up all socket handlers
        setupSocketHandlers();

        // 4. Join the room
        socket.emit("join-room", { roomId, username });

        // 5. Set up UI buttons
        setupControls();
      } catch (err) {
        console.error("Error accessing media devices:", err);
        alert(
          "Could not access camera/microphone.\n\n" +
            "Error: " +
            err.name +
            " - " +
            err.message +
            "\n\n" +
            "Please check browser permissions and that no other app is using your camera/mic."
        );
      }
    }

    // ============================= Socket.IO ================================
    function setupSocketHandlers() {
      socket.on("room-joined", (payload) => {
        const { yourId, participants: existingParticipants, iceServers } =
          payload;

        iceServersFromServer = iceServers || [];
        console.log("ICE servers from server:", iceServersFromServer);

        // Fill participants list
        participantsList.innerHTML = "";
        existingParticipants.forEach((p) => {
          participants[p.id] = p.username;
        });
        renderParticipants(yourId);

        // For every existing participant (except ourselves), create a PC + offer
        existingParticipants.forEach((p) => {
          if (p.id === yourId) return;
          createPeerConnectionAndOffer(p.id);
        });
      });

      socket.on("user-joined", ({ socketId, username: newUserName }) => {
        console.log("User joined:", socketId, newUserName);
        participants[socketId] = newUserName;
        renderParticipants(socket.id);
        // We are already in the room; we start WebRTC with this new user
        createPeerConnectionAndOffer(socketId);
      });

      socket.on("user-left", ({ socketId }) => {
        console.log("User left:", socketId);
        delete participants[socketId];
        renderParticipants(socket.id);

        const pc = peerConnections[socketId];
        if (pc) {
          pc.close();
          delete peerConnections[socketId];
        }

        const wrapper = remoteVideoElements[socketId];
        if (wrapper && wrapper.parentNode) {
          wrapper.parentNode.removeChild(wrapper);
        }
        delete remoteVideoElements[socketId];
      });

      socket.on("signal-offer", async ({ from, offer }) => {
        console.log("Received offer from", from);
        let pc = peerConnections[from];

        if (!pc) {
          pc = createPeerConnection(from);
        }

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          addLocalTracksToPeer(pc);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          socket.emit("signal-answer", {
            roomId,
            to: from,
            answer: pc.localDescription,
          });
        } catch (err) {
          console.error("Error handling offer:", err);
        }
      });

      socket.on("signal-answer", async ({ from, answer }) => {
        console.log("Received answer from", from);
        const pc = peerConnections[from];
        if (!pc) return;

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error("Error setting remote description:", err);
        }
      });

      socket.on("signal-ice-candidate", async ({ from, candidate }) => {
        const pc = peerConnections[from];
        if (!pc) return;

        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("Error adding received ICE candidate:", err);
        }
      });

      socket.on("chat-message", ({ username, message, time }) => {
        addChatMessage(username, message, time);
      });
    }

    // ====================== RTCPeerConnection helpers =======================

    async function createPeerConnectionAndOffer(peerId) {
      const pc = createPeerConnection(peerId);

      try {
        addLocalTracksToPeer(pc);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("signal-offer", {
          roomId,
          to: peerId,
          offer: pc.localDescription,
        });
      } catch (err) {
        console.error("Error creating offer:", err);
      }
    }

    function createPeerConnection(peerId) {
      console.log("Creating PeerConnection for", peerId);

      const pc = new RTCPeerConnection({
        iceServers: iceServersFromServer,
      });

      peerConnections[peerId] = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("signal-ice-candidate", {
            roomId,
            to: peerId,
            candidate: event.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log(
          "Connection state with",
          peerId,
          ":",
          pc.connectionState
        );
      };

      // IMPORTANT: This handles both video + audio from remote
      pc.ontrack = (event) => {
        console.log(
          "ontrack from",
          peerId,
          "kind:",
          event.track && event.track.kind
        );

        const remoteStream = event.streams[0];

        let wrapper = remoteVideoElements[peerId];
        let video;

        if (!wrapper) {
          wrapper = document.createElement("div");
          wrapper.className = "remote-video-wrapper";

          video = document.createElement("video");
          video.autoplay = true;
          video.playsInline = true;
          video.className = "remote-video-element";
          video.muted = true; // we WANT to hear remote audio

          const label = document.createElement("div");
          label.className = "remote-video-label";
          label.textContent = participants[peerId] || "Guest";

          wrapper.appendChild(video);
          wrapper.appendChild(label);

          remoteVideosContainer.appendChild(wrapper);
          remoteVideoElements[peerId] = wrapper;
        } else {
          video = wrapper.querySelector("video");
        }

        // Attach stream (both audio + video)
        video.srcObject = remoteStream;

        // Try to play (some browsers require this)
        video
          .play()
          .then(() => {
            console.log("Remote video playing for", peerId);
          })
          .catch((err) => {
            console.warn("Remote video play() was blocked:", err);
          });
      };

      return pc;
    }

    function addLocalTracksToPeer(pc) {
      if (!localStream) return;
      const senders = pc.getSenders();

      localStream.getTracks().forEach((track) => {
        const alreadySent = senders.some(
          (s) => s.track && s.track.kind === track.kind
        );
        if (!alreadySent) {
          pc.addTrack(track, localStream);
        }
      });
    }

    // =============================== Controls ===============================

    function setupControls() {
      // Mic ON/OFF
      btnToggleMic.addEventListener("click", () => {
        if (!localStream) return;
        isAudioEnabled = !isAudioEnabled;
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = isAudioEnabled;
        });
        btnToggleMic.textContent = isAudioEnabled ? "🎙️ Mute" : "🎙️ Unmute";
      });

      // Camera ON/OFF
      btnToggleCamera.addEventListener("click", () => {
        if (!localStream) return;
        isVideoEnabled = !isVideoEnabled;
        localStream.getVideoTracks().forEach((track) => {
          track.enabled = isVideoEnabled;
        });
        btnToggleCamera.textContent = isVideoEnabled
          ? "📷 Camera Off"
          : "📷 Camera On";
      });

      // Screen sharing
      btnShareScreen.addEventListener("click", async () => {
        if (!isScreenSharing) {
          await startScreenShare();
        } else {
          stopScreenShare();
        }
      });

      // Chat
      chatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const message = chatInput.value.trim();
        if (!message) return;
        chatInput.value = "";

        socket.emit("send-chat-message", { roomId, message });
      });
    }

    // ============================ Screen sharing ============================

    async function startScreenShare() {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });

        const screenTrack = screenStream.getVideoTracks()[0];

        Object.values(peerConnections).forEach((pc) => {
          const sender = pc
            .getSenders()
            .find((s) => s.track && s.track.kind === "video");
          if (sender && screenTrack) {
            sender.replaceTrack(screenTrack);
          }
        });

        localVideo.srcObject = screenStream;
        isScreenSharing = true;
        btnShareScreen.textContent = "🖥️ Stop Share";

        screenTrack.onended = () => {
          stopScreenShare();
        };
      } catch (err) {
        console.error("Error starting screen share:", err);
      }
    }

    function stopScreenShare() {
      if (!isScreenSharing) return;

      const cameraVideoTrack =
        localStream && localStream.getVideoTracks()[0];

      Object.values(peerConnections).forEach((pc) => {
        const sender = pc
          .getSenders()
          .find((s) => s.track && s.track.kind === "video");
        if (sender && cameraVideoTrack) {
          sender.replaceTrack(cameraVideoTrack);
        }
      });

      if (screenStream) {
        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;
      }

      localVideo.srcObject = localStream;
      isScreenSharing = false;
      btnShareScreen.textContent = "🖥️ Share Screen";
    }

    // ========================== Participants list ===========================

    function renderParticipants(ownId) {
      participantsList.innerHTML = "";

      Object.entries(participants).forEach(([id, name]) => {
        const li = document.createElement("li");
        li.textContent = id === ownId ? `${name} (You)` : name;
        participantsList.appendChild(li);
      });
    }

    // =============================== Chat UI ================================

    function addChatMessage(username, message, timeISO) {
      const msgEl = document.createElement("div");
      msgEl.className = "chat-message";

      const nameEl = document.createElement("span");
      nameEl.className = "chat-username";
      nameEl.textContent = username;

      const timeEl = document.createElement("span");
      timeEl.className = "chat-time";
      const time = new Date(timeISO || Date.now());
      timeEl.textContent = `(${time.toLocaleTimeString()})`;

      const textEl = document.createElement("span");
      textEl.textContent = " " + message;

      msgEl.appendChild(nameEl);
      msgEl.appendChild(timeEl);
      msgEl.appendChild(textEl);

      chatMessages.appendChild(msgEl);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }
})();
