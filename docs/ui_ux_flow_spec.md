# UI/UX Screens & Client States Specification (Shipri)

Shipri presents a two-peer room with a shared file board. There are no permanent sender and receiver screens. Both peers may add local files and download remote files.

---

## 1. Room Entry

### Create room

The user creates a room, receives a share link and QR code, and enters the room board immediately.

### Join room

The user opens the shared link, the fragment key is extracted and removed from the visible URL, and the user enters the same room board.

Creator and joiner labels are not shown as transfer roles.

---

## 2. Shared File Board

The main screen contains:

* room connection and direct/relay status;
* copy-link and QR controls;
* a dropzone and file picker available to either peer;
* cards for files shared by the local peer;
* cards for files shared by the remote peer;
* independent transfer progress rows.

Local file cards show `Shared by you` and allow removal. Remote file cards show `Available from peer` and a `Download` action.

File metadata is displayed only after local decryption. A remote file card never implies that the file is stored on the server.

---

## 3. Add and Remove Files

When either peer drops or selects files:

1. the files remain local;
2. encrypted advertisements are sent over `shipri-control`;
3. the remote board updates without starting a download.

Removing a local advertisement removes it from both boards. Active transfers require a separate cancel action.

---

## 4. Download Flow

When a user clicks a remote file:

1. capability and size-limit messaging is shown when relevant;
2. the browser save dialog or supported persistence path opens;
3. cancelling the dialog leaves the board unchanged and sends no request;
4. after persistence is ready, a download request is sent to the file owner;
5. the transfer appears as an independent progress row.

Each progress row shows direction, filename, bytes, speed, ETA, connection status, pause/resume, and cancel controls.

---

## 5. Connection and Failure States

* When alone, the room board stays usable for adding local files and displays `Waiting for another peer`.
* When the remote peer disconnects, its files become unavailable during the reconnect window.
* Reconnection restores the encrypted board and eligible transfers.
* A failed or cancelled transfer affects only its progress row.
* Accessible status announcements, keyboard controls, focus handling, and responsive layouts are required for every board action.
