# Technical Specification: Project Shipri

## 1\. Brand Identity & Strategic Overview

### 1.1. Brand Conception & Name Origin

The name **Shipri** is a deliberate, high-impact evolution of the conceptual root *"Marshipri"*. To optimize the name for a global tech audience, product marketing, and brand memorability, the prefix *"mar-"* was removed. This streamlining shifts the focus entirely onto a sharp, modern, and dual-meaning identifier:

* **"Ship"**: Represents maximum velocity, delivery, deployment, and the immediate transport of data packets directly from source to destination.  
* **"Pri"**: Embodies uncompromising **Privacy**, data sovereignty, encryption, and the premium nature of a dedicated **Peer-to-Peer (P2P)** priority lane.

**Shipri** stands as a verbal metaphor for its core functionality: *shipping files directly between peers with maximum speed and absolute privacy.*

### 1.2. Executive Summary & Problem Statement

Traditional file-sharing methods rely heavily on centralized cloud infrastructures (e.g., Google Drive, Dropbox, WeTransfer). These solutions introduce several critical friction points for users:

1. **Privacy Concerns**: Files are temporarily or permanently cached on external servers, exposing them to potential data breaches, corporate telemetry, or unauthorized access.  
2. **Storage & Arbitrary Limits**: Free tiers strictly throttle transfer speeds, restrict individual file sizes (e.g., limits of 2GB per transfer), or mandate intrusive user registration.  
3. **Network Inefficiency**: Transferring a file to a peer in the same local network or even across the city requires uploading the data entirely to a remote data center first, and then downloading it back, effectively cutting the available network throughput in half.

**Shipri** resolves these inefficiencies by establishing an instant, browser-based, serverless data pipeline directly between the sender and the receiver.

### 1.3. Product Philosophy & Non-Negotiable Pillars

Every architectural choice in the development of Shipri must adhere to the following three pillars:

* **Zero Server Storage (Absolute Privacy)**: The application must never store, read, intercept, or write user files to a server file system or database. The server acts exclusively as a temporary matchmaker (signaling agent).  
* **Infinite File Sizes**: The system architecture must rely strictly on continuous binary data streams. The application must support files of arbitrary volume (e.g., 10GB, 50GB, or larger) bounded only by the user's hard drive space, without ever causing the browser tab to exhaust its allocated RAM or crash.  
* **Frictionless UX / Public Accessibility**: Users should be able to initiate a secure file transfer in under three clicks, without forced account creation, onboarding tunnels, or plugin installations. The codebase remains entirely open-source and public to encourage community audits and developer collaboration.

## 2\. Signaling Architecture & Room Logic

### 2.1. The Role of the Signaling Server

Since WebRTC operates on a direct Peer-to-Peer basis, browsers cannot discover each other's network locations (IP addresses, open ports, NAT configurations) without an initial intermediary. Shipri utilizes a lightweight Node.js server powered by Socket.IO to act as this intermediary (the Signaling Server).

The server’s responsibilities are strictly limited to:

* Managing ephemeral virtual "Rooms".  
* Relaying WebRTC configuration metadata (SDP Offers, SDP Answers, and ICE Candidates) between two connected sockets.  
* Tracking room occupancy and disconnecting idle rooms.  
* Security Boundaries: The signaling server never touches, intercepts, or processes any file data or file metadata. It only orchestrates the connection parameters.

### 2.2. Room-Link & Code Assignment Protocol

To make connection initiation as intuitive as possible, Shipri avoids requiring users to manually copy complex, multi-kilobyte cryptographic strings. Instead, it uses a short-lived URL routing model plus a fragment key that remains client-side:

1. Room Initialization (Sender):  
   * The Sender opens the web application and clicks the "Create Room" button.  
   * The client establishes a WebSocket connection with the signaling server and emits a `room:create` event.  
2. Code Generation (Server):  
   * The server generates a unique, short, URL-friendly room ID in the canonical `ship-[a-f0-9]{4}` format (for example, `ship-83a1`).  
   * The server allocates an internal memory structure to track this room, registers the Sender's socket ID as the room host, and joins that socket into a standard Socket.IO room channel.  
3. UI State Mutation:  
   * The server responds to the client with a `room:created` event containing `roomId`.  
   * The Sender’s frontend catches this event and immediately mutates the browser's address bar via the HTML5 History API (`window.history.pushState`) to match the route: `shipri.app/room/{roomId}#key={urlSafeBase64Key}`.  
   * The UI displays a prominent "Copy Link" module alongside a dynamically generated QR code containing the full URL, including the fragment key.  
4. Room Joining (Receiver):  
   * The Receiver opens the shared link or scans the QR-code.  
   * The frontend extracts the key from `window.location.hash`, removes the fragment from the visible address bar, and detects `{roomId}` from the URL path during the initial React component mounting phase.  
   * The Receiver's client establishes a WebSocket connection to the server and immediately emits a `room:join` event along with the target `roomId`.

### 2.3. Step-by-Step WebRTC Handshake Sequence

Once both peers are registered in the same virtual server room, the Socket.IO server coordinates the WebRTC signaling sequence to bridge the P2P connection:

1. Occupancy Verification: When the Receiver emits `room:join`, the server checks room capacity. If the room already contains 2 active connections, it rejects the newcomer with `room:error` and code `ROOM_FULL`. If it has exactly 1 peer (the Host), it proceeds.  
2. Peer Notification: The server sends a `peer:joined` event to the Host, signaling that a recipient is ready to establish a pipeline.  
3. SDP Offer Generation:  
   * Upon receiving `peer:joined`, the Host creates a native `RTCPeerConnection` with the ICE server configuration received from the signaling server.  
   * The Host creates the `shipri-control` and `shipri-binary` data channels, then generates a Session Description Protocol (SDP) Offer containing local data capabilities and encryption fingerprints.  
   * The Host forwards local SDP and ICE candidates to the server via `signal:forward` WebSocket events.  
4. SDP Offer Relay: The server catches the offer and relays it directly to the Receiver's socket ID in the room.  
5. SDP Answer Generation:  
   * The Receiver receives the SDP Offer and immediately creates its own native `RTCPeerConnection` with the same ICE configuration.  
   * The Receiver applies the remote offer, creates an SDP Answer, and emits it back to the server through `signal:forward`.  
6. SDP Answer Relay: The server delivers the SDP Answer to the original Host socket, which applies it as the remote description.  
7. ICE Trickling: Simultaneously, both browsers engage in "ICE Trickling". They communicate with public STUN servers to discover their public IP mappings. As individual ICE candidates are generated on either client, they are relayed through the WebSocket server and added to the opposing peer connection.  
8. Signaling Cut-off: Once the underlying `RTCPeerConnection` transitions its `iceConnectionState` to `'connected'`, a direct, encrypted binary data channel is active. At this moment, the WebSocket connections can safely enter a dormant state, as all subsequent application interactions occur entirely peer-to-peer.
