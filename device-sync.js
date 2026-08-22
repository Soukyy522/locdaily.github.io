(function () {
    "use strict";

    /* =========================================================
       LocDailyMar Device A ↔ Device B Sync
       Relay: HTTP + Server-Sent Events (SSE)
       Tidak memakai PeerJS / WebRTC.
       ========================================================= */

    const CONFIG_KEY = "ldmDeviceSync:config";
    const OUTBOX_KEY = "ldmDeviceSync:outbox";
    const DEVICE_ID_KEY = "ldmDeviceSync:deviceId";
    const STATUS_EVENT = "ldm-device-sync-status";
    const DATA_EVENT = "ldm-sync-updated";

    const ARRAY_KEYS = new Set([
        "laporan",
        "laporanHistory",
        "riwayatTransaksi",
        "dataBarang",
        "operasional",
        "dataAbsensi",
        "dataStockOpname",
        "dataPurchaseOrder",
        "goodsReceiptSourcePO",
        "dataGoodsReceipt",
        "auditLog",
        "shiftClosingLog",
        "endOfDayLog"
    ]);

    const REPLACE_KEYS = new Set([
        "headerConfig",
        "strukConfig"
    ]);

    const SYNC_KEYS = new Set([
        ...ARRAY_KEYS,
        ...REPLACE_KEYS
    ]);

    const ALIAS_TO_CANONICAL = {
        dataLaporan: "laporan"
    };

    const MIRRORS = {
        laporan: ["dataLaporan"]
    };

    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const originalGetItem = Storage.prototype.getItem;

    let eventSource = null;
    let applyingRemote = false;
    let expectedSnapshot = false;
    let currentMode = "resume";
    let createRetryCount = 0;
    let flushingOutbox = false;
    let lastPeers = 0;

    function safeParse(raw, fallback) {
        try {
            const parsed = JSON.parse(raw);
            return parsed == null ? fallback : parsed;
        } catch (_) {
            return fallback;
        }
    }

    function getDeviceId() {
        let id = originalGetItem.call(localStorage, DEVICE_ID_KEY);
        if (id) return id;

        if (window.crypto && typeof crypto.randomUUID === "function") {
            id = "dev_" + crypto.randomUUID();
        } else {
            id = "dev_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
        }

        originalSetItem.call(localStorage, DEVICE_ID_KEY, id);
        return id;
    }

    function defaultServerBase() {
        if (location.protocol === "http:" || location.protocol === "https:") {
            return location.origin;
        }
        return "http://127.0.0.1:8787";
    }

    function normalizeServerBase(value) {
        let base = String(value || defaultServerBase()).trim();
        base = base.replace(/\/+$/, "");
        return base;
    }

    function getConfig() {
        const cfg = safeParse(originalGetItem.call(localStorage, CONFIG_KEY), {});
        return cfg && typeof cfg === "object" ? cfg : {};
    }

    function saveConfig(config) {
        originalSetItem.call(localStorage, CONFIG_KEY, JSON.stringify(config));
    }

    function clearConfig() {
        originalRemoveItem.call(localStorage, CONFIG_KEY);
    }

    function canonicalKey(key) {
        return ALIAS_TO_CANONICAL[key] || key;
    }

    function normalizeRoomCode(value) {
        return String(value || "")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(0, 8);
    }

    function displayRoomCode(value) {
        const clean = normalizeRoomCode(value);
        return clean.length > 4 ? clean.slice(0, 4) + "-" + clean.slice(4) : clean;
    }

    function generateRoomCode() {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const bytes = new Uint8Array(8);
        if (window.crypto && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        let result = "";
        for (let i = 0; i < bytes.length; i++) result += alphabet[bytes[i] % alphabet.length];
        return result;
    }

    function hashString(input) {
        let hash = 2166136261;
        const text = String(input || "");
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function itemIdentity(key, item, index) {
        if (item == null || typeof item !== "object") {
            return "primitive:" + hashString(JSON.stringify(item));
        }

        const pick = (...names) => {
            for (const name of names) {
                const value = item[name];
                if (value !== undefined && value !== null && String(value).trim() !== "") {
                    return String(value).trim();
                }
            }
            return "";
        };

        let id = pick("id", "uuid", "uid", "_id");
        if (id) return "id:" + id;

        if (key === "dataBarang") {
            id = pick("barcode", "kodeBarang", "kode", "sku", "plu");
            if (id) return "barang:" + id.toLowerCase();
            id = pick("nama", "name");
            if (id) return "barang-nama:" + id.toLowerCase();
        }

        if (key === "shiftClosingLog") {
            const date = pick("tanggal", "date");
            const cashier = pick("kasir", "username", "user").toLowerCase();
            const shift = pick("shift").toLowerCase();
            if (date && cashier && shift) return "closing:" + date + "|" + cashier + "|" + shift;
        }

        if (key === "dataAbsensi") {
            const date = pick("tanggal", "date");
            const user = pick("employeeId", "nikKaryawan", "username", "user").toLowerCase();
            const type = pick("jenis", "status", "type").toLowerCase();
            if (date && user) return "absensi:" + date + "|" + user + "|" + type;
        }

        if (key === "dataPurchaseOrder" || key === "goodsReceiptSourcePO") {
            id = pick("noPO", "nomorPO", "poNumber", "kodePO", "poId");
            if (id) return "po:" + id.toLowerCase();
        }

        if (key === "dataGoodsReceipt") {
            id = pick("noGR", "nomorGR", "grNumber", "kodeGR", "receiptNo", "noPO", "nomorPO");
            if (id) return "gr:" + id.toLowerCase();
        }

        if (key === "laporan" || key === "laporanHistory" || key === "riwayatTransaksi") {
            id = pick("timestamp", "createdAt", "waktu", "tanggal");
            const cashier = pick("kasir", "username", "user").toLowerCase();
            if (id) return "trx:" + id + "|" + cashier;
        }

        id = pick("employeeId", "nikKaryawan", "username", "kode", "nomor", "number", "timestamp", "createdAt");
        if (id) return "generic:" + id.toLowerCase();

        return "json:" + hashString(JSON.stringify(item)) + ":" + index;
    }

    function arrayMap(key, value) {
        const map = new Map();
        (Array.isArray(value) ? value : []).forEach((item, index) => {
            map.set(itemIdentity(key, item, index), item);
        });
        return map;
    }

    function buildArrayPatch(key, oldRaw, newRaw) {
        const oldValue = safeParse(oldRaw, []);
        const newValue = safeParse(newRaw, []);
        if (!Array.isArray(oldValue) || !Array.isArray(newValue)) return null;

        const oldMap = arrayMap(key, oldValue);
        const newMap = arrayMap(key, newValue);
        const upserts = [];
        const deletes = [];

        for (const [id, item] of newMap.entries()) {
            if (!oldMap.has(id) || JSON.stringify(oldMap.get(id)) !== JSON.stringify(item)) {
                upserts.push({ id, item });
            }
        }

        for (const id of oldMap.keys()) {
            if (!newMap.has(id)) deletes.push(id);
        }

        return { upserts, deletes };
    }

    function getOutbox() {
        const data = safeParse(originalGetItem.call(localStorage, OUTBOX_KEY), []);
        return Array.isArray(data) ? data : [];
    }

    function saveOutbox(items) {
        originalSetItem.call(localStorage, OUTBOX_KEY, JSON.stringify(items.slice(-500)));
    }

    function enqueue(operation) {
        const outbox = getOutbox();
        outbox.push(operation);
        saveOutbox(outbox);
        flushOutbox();
    }

    function notifyStatus(status, extra = {}) {
        const detail = { status, peers: lastPeers, ...extra, config: getConfig() };
        window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail }));
        if (window.LDMDeviceSyncUI && typeof window.LDMDeviceSyncUI.renderStatus === "function") {
            window.LDMDeviceSyncUI.renderStatus(detail);
        }
    }

    function dispatchDataEvent(key, value) {
        window.dispatchEvent(new CustomEvent(DATA_EVENT, { detail: { key, value } }));
        try {
            window.dispatchEvent(new StorageEvent("storage", {
                key,
                newValue: value,
                storageArea: localStorage,
                url: location.href
            }));
        } catch (_) {
            window.dispatchEvent(new Event("storage"));
        }
    }

    function rebuildShiftDailyLogs() {
        const logs = safeParse(originalGetItem.call(localStorage, "shiftClosingLog"), []);
        if (!Array.isArray(logs)) return;
        const map = {};
        logs.forEach(log => {
            const date = String(log && log.tanggal || "");
            if (!date) return;
            if (!map[date]) map[date] = [];
            map[date].push(log);
        });
        Object.keys(map).forEach(date => {
            map[date].sort((a, b) => Number(b && b.id || 0) - Number(a && a.id || 0));
        });
        originalSetItem.call(localStorage, "shiftClosingDailyLogs", JSON.stringify(map));
    }

    function applyCanonicalValue(key, rawValue) {
        applyingRemote = true;
        try {
            if (rawValue === null || rawValue === undefined) {
                originalRemoveItem.call(localStorage, key);
                (MIRRORS[key] || []).forEach(mirror => originalRemoveItem.call(localStorage, mirror));
            } else {
                originalSetItem.call(localStorage, key, String(rawValue));
                (MIRRORS[key] || []).forEach(mirror => originalSetItem.call(localStorage, mirror, String(rawValue)));
            }
            if (key === "shiftClosingLog") rebuildShiftDailyLogs();
        } finally {
            applyingRemote = false;
        }
        dispatchDataEvent(key, rawValue);
    }

    function applySnapshot(data, clearMissing = true) {
        applyingRemote = true;
        try {
            if (clearMissing) {
                SYNC_KEYS.forEach(key => {
                    if (!Object.prototype.hasOwnProperty.call(data || {}, key)) {
                        originalRemoveItem.call(localStorage, key);
                        (MIRRORS[key] || []).forEach(mirror => originalRemoveItem.call(localStorage, mirror));
                    }
                });
            }

            Object.entries(data || {}).forEach(([key, value]) => {
                if (!SYNC_KEYS.has(key)) return;
                if (value === null || value === undefined) {
                    originalRemoveItem.call(localStorage, key);
                    (MIRRORS[key] || []).forEach(mirror => originalRemoveItem.call(localStorage, mirror));
                } else {
                    originalSetItem.call(localStorage, key, String(value));
                    (MIRRORS[key] || []).forEach(mirror => originalSetItem.call(localStorage, mirror, String(value)));
                }
            });
            rebuildShiftDailyLogs();
        } finally {
            applyingRemote = false;
        }

        Object.entries(data || {}).forEach(([key, value]) => dispatchDataEvent(key, value));
    }

    function collectSnapshot() {
        const snapshot = {};
        SYNC_KEYS.forEach(key => {
            const value = originalGetItem.call(localStorage, key);
            if (value !== null) snapshot[key] = value;
        });
        return snapshot;
    }

    function makeOperation(key, oldRaw, newRaw) {
        const canonical = canonicalKey(key);
        if (!SYNC_KEYS.has(canonical)) return null;

        if (ARRAY_KEYS.has(canonical)) {
            const patch = buildArrayPatch(canonical, oldRaw, newRaw);
            if (patch && (patch.upserts.length || patch.deletes.length)) {
                return {
                    action: "arrayPatch",
                    key: canonical,
                    upserts: patch.upserts,
                    deletes: patch.deletes,
                    ts: Date.now()
                };
            }
        }

        if (oldRaw !== newRaw) {
            return {
                action: "replace",
                key: canonical,
                value: newRaw,
                ts: Date.now()
            };
        }
        return null;
    }

    Storage.prototype.setItem = function (key, value) {
        if (this !== localStorage) return originalSetItem.call(this, key, value);

        const stringValue = String(value);
        const canonical = canonicalKey(key);
        const oldCanonical = originalGetItem.call(localStorage, canonical);

        originalSetItem.call(this, key, stringValue);

        if (applyingRemote || !SYNC_KEYS.has(canonical)) return;

        if (canonical !== key) originalSetItem.call(localStorage, canonical, stringValue);
        (MIRRORS[canonical] || []).forEach(mirror => {
            if (mirror !== key) originalSetItem.call(localStorage, mirror, stringValue);
        });

        const operation = makeOperation(canonical, oldCanonical, stringValue);
        if (operation) enqueue(operation);
    };

    Storage.prototype.removeItem = function (key) {
        if (this !== localStorage) return originalRemoveItem.call(this, key);

        const canonical = canonicalKey(key);
        const existed = originalGetItem.call(localStorage, canonical) !== null;
        originalRemoveItem.call(this, key);
        if (canonical !== key) originalRemoveItem.call(localStorage, canonical);
        (MIRRORS[canonical] || []).forEach(mirror => originalRemoveItem.call(localStorage, mirror));

        if (applyingRemote || !SYNC_KEYS.has(canonical) || !existed) return;
        enqueue({ action: "deleteKey", key: canonical, ts: Date.now() });
    };

    async function postOperation(operation) {
        const config = getConfig();
        if (!config.room || !config.serverBase) throw new Error("Belum terhubung");

        const response = await fetch(normalizeServerBase(config.serverBase) + "/sync/op", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                room: config.room,
                deviceId: getDeviceId(),
                operation
            })
        });

        if (!response.ok) {
            let message = "Sync Server menolak perubahan.";
            try {
                const payload = await response.json();
                if (payload.message) message = payload.message;
            } catch (_) {}
            throw new Error(message);
        }
        return response.json().catch(() => ({}));
    }

    async function flushOutbox() {
        if (flushingOutbox || expectedSnapshot) return;
        const config = getConfig();
        if (!config.room || !config.serverBase || !eventSource) return;

        flushingOutbox = true;
        try {
            while (true) {
                const outbox = getOutbox();
                if (!outbox.length) break;

                const first = outbox[0];
                try {
                    await postOperation(first);
                } catch (error) {
                    notifyStatus("reconnecting", { message: error.message });
                    break;
                }

                const latest = getOutbox();
                latest.shift();
                saveOutbox(latest);
            }
        } finally {
            flushingOutbox = false;
        }
    }

    function eventUrl(serverBase, room, mode) {
        const url = new URL(normalizeServerBase(serverBase) + "/sync/events");
        url.searchParams.set("room", normalizeRoomCode(room));
        url.searchParams.set("device", getDeviceId());
        url.searchParams.set("mode", mode || "resume");
        return url.toString();
    }

    function closeStream() {
        if (eventSource) {
            try { eventSource.close(); } catch (_) {}
            eventSource = null;
        }
    }

    function handleServerMessage(message, serverBase, room) {
        if (!message || typeof message !== "object") return;

        if (message.type === "error") {
            notifyStatus("error", { message: message.message || "Gagal terhubung.", code: message.code });
            if (message.code === "ROOM_EXISTS" && currentMode === "create" && createRetryCount < 5) {
                createRetryCount++;
                closeStream();
                setTimeout(() => connect({
                    serverBase,
                    room: generateRoomCode(),
                    mode: "create",
                    remember: true
                }), 120);
            }
            return;
        }

        if (message.type === "connected") {
            lastPeers = Number(message.peers || 1);
            notifyStatus("connected", { peers: lastPeers, room: displayRoomCode(room), serverBase });
            if (currentMode === "create") {
                postOperation({
                    action: "snapshot",
                    data: collectSnapshot(),
                    ts: Date.now()
                }).catch(error => notifyStatus("error", { message: error.message }));
            }
            return;
        }

        if (message.type === "snapshot") {
            lastPeers = Number(message.peers || lastPeers || 1);
            expectedSnapshot = false;
            applySnapshot(message.data || {}, true);
            notifyStatus("synced", { peers: lastPeers, room: displayRoomCode(room), serverBase });
            flushOutbox();
            return;
        }

        if (message.type === "updateKey") {
            lastPeers = Number(message.peers || lastPeers || 1);
            applyCanonicalValue(message.key, message.value);
            notifyStatus("synced", { peers: lastPeers, room: displayRoomCode(room), serverBase });
            return;
        }

        if (message.type === "deleteKey") {
            lastPeers = Number(message.peers || lastPeers || 1);
            applyCanonicalValue(message.key, null);
            notifyStatus("synced", { peers: lastPeers, room: displayRoomCode(room), serverBase });
            return;
        }

        if (message.type === "peerCount") {
            lastPeers = Number(message.peers || 0);
            notifyStatus("connected", { peers: lastPeers, room: displayRoomCode(room), serverBase });
        }
    }

    function connect({ serverBase, room, mode = "resume", remember = true } = {}) {
        serverBase = normalizeServerBase(serverBase || defaultServerBase());
        room = normalizeRoomCode(room);

        if (room.length !== 8) {
            notifyStatus("error", { message: "Kode sambungan harus 8 karakter." });
            return;
        }

        currentMode = mode;
        expectedSnapshot = true;
        closeStream();

        if (remember) {
            saveConfig({ room, serverBase, connectedAt: Date.now() });
        }

        notifyStatus("connecting", { room: displayRoomCode(room), serverBase });

        const source = new EventSource(eventUrl(serverBase, room, mode));
        eventSource = source;

        source.onmessage = event => {
            let message;
            try { message = JSON.parse(event.data); } catch (_) { return; }
            handleServerMessage(message, serverBase, room);
        };

        source.onerror = () => {
            notifyStatus("reconnecting", { room: displayRoomCode(room), serverBase });
        };
    }

    function createRoom(serverBase) {
        createRetryCount = 0;
        const room = generateRoomCode();
        connect({ serverBase: serverBase || defaultServerBase(), room, mode: "create", remember: true });
        return room;
    }

    function joinRoom(room, serverBase) {
        connect({ serverBase: serverBase || defaultServerBase(), room, mode: "join", remember: true });
    }

    function disconnect(forget = true) {
        closeStream();
        expectedSnapshot = false;
        lastPeers = 0;
        if (forget) {
            clearConfig();
            saveOutbox([]);
        }
        notifyStatus("disconnected", { peers: 0 });
    }

    function autoConnect() {
        const config = getConfig();
        if (!config.room || !config.serverBase) {
            notifyStatus("disconnected", { peers: 0 });
            return;
        }
        connect({ serverBase: config.serverBase, room: config.room, mode: "resume", remember: false });
    }

    /* ================= Dashboard UI ================= */

    function isDashboardPage() {
        const path = String(location.pathname || "").toLowerCase();
        return path.endsWith("/dashboard.html") || path === "dashboard.html" || path.endsWith("/dashboard") || path === "/dashboard.html";
    }

    function installDashboardUI() {
        if (!isDashboardPage()) return;

        // UI P2P lama disembunyikan. Sinkronisasi baru tidak memakai PeerJS.
        ["btnKirimOwner", "btnTarikKasir", "modalKodeKasir", "modalInputOwner"].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.style.display = "none";
        });

        const group = document.querySelector(".action-bar-container .btn-action-group") || document.querySelector(".action-bar-container");
        if (group && !document.getElementById("btnDeviceSync")) {
            const button = document.createElement("button");
            button.type = "button";
            button.id = "btnDeviceSync";
            button.className = "btn-transfer-owner";
            button.innerHTML = '<span id="deviceSyncDot">⚪</span> <span id="deviceSyncButtonText">Hubungkan Device</span>';
            button.addEventListener("click", openModal);
            group.appendChild(button);
        }

        if (!document.getElementById("ldmDeviceSyncModal")) {
            const modal = document.createElement("div");
            modal.className = "modal-alert";
            modal.id = "ldmDeviceSyncModal";
            modal.innerHTML = `
                <div class="modal-alert-content" style="width:min(540px,94vw);max-width:540px;text-align:left;">
                    <div class="modal-alert-icon" style="text-align:center;">🔗</div>
                    <div class="modal-alert-title" style="text-align:center;">Hubungkan Device A ↔ Device B</div>

                    <div style="margin:10px 0 13px;padding:10px 12px;border:1px solid var(--border-color);border-radius:9px;background:var(--bg-primary);font-size:.72rem;line-height:1.55;">
                        <strong>Status:</strong> <span id="ldmSyncStatusText">Belum terhubung</span><br>
                        <span id="ldmSyncPeerText" style="color:var(--label-color);">Device terhubung: 0</span>
                    </div>

                    <div style="margin-bottom:12px;">
                        <label style="display:block;margin-bottom:5px;font-size:.69rem;font-weight:700;color:var(--label-color);">Alamat Sync Server</label>
                        <input id="ldmSyncServerBase" type="text" placeholder="http://192.168.1.10:8787" style="width:100%;padding:9px 10px;border:1px solid var(--border-color);border-radius:8px;background:var(--input-bg);color:var(--text-color);">
                        <small style="display:block;margin-top:4px;color:var(--label-color);font-size:.61rem;line-height:1.45;">Jika aplikasi dibuka melalui sync-server.js, alamat ini terisi otomatis.</small>
                    </div>

                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                        <div style="border:1px solid var(--border-color);border-radius:10px;padding:11px;">
                            <strong style="font-size:.77rem;">Device A</strong>
                            <p style="margin:4px 0 8px;font-size:.63rem;line-height:1.45;color:var(--label-color);">Menjadi sumber data awal dan membuat kode sambungan.</p>
                            <button type="button" class="btn-modal-ok" style="background:#0d2240;color:#ffc107;" onclick="LDMDeviceSyncUI.createRoom()">Buat Kode Sambungan</button>
                        </div>

                        <div style="border:1px solid var(--border-color);border-radius:10px;padding:11px;">
                            <strong style="font-size:.77rem;">Device B</strong>
                            <p style="margin:4px 0 8px;font-size:.63rem;line-height:1.45;color:var(--label-color);">Masukkan kode dari Device A. Data awal Device A akan diterima terlebih dahulu.</p>
                            <input id="ldmJoinCode" maxlength="9" placeholder="ABCD-EFGH" style="width:100%;padding:8px;text-transform:uppercase;text-align:center;letter-spacing:.12em;border:1px solid var(--border-color);border-radius:8px;background:var(--input-bg);color:var(--text-color);margin-bottom:7px;">
                            <button type="button" class="btn-modal-ok" style="background:#16a34a;" onclick="LDMDeviceSyncUI.joinRoom()">Hubungkan Device B</button>
                        </div>
                    </div>

                    <div id="ldmRoomCodeWrap" style="display:none;margin-top:12px;padding:12px;border:1px dashed var(--border-color);border-radius:10px;text-align:center;">
                        <div style="font-size:.62rem;color:var(--label-color);margin-bottom:4px;">KODE SAMBUNGAN</div>
                        <div id="ldmRoomCode" style="font:800 1.35rem monospace;letter-spacing:.14em;color:var(--heading-color);">--------</div>
                        <button type="button" class="btn-copy-code" style="margin-top:7px;" onclick="LDMDeviceSyncUI.copyCode()">📋 Salin Kode</button>
                    </div>

                    <div style="margin-top:12px;padding:9px 10px;border-radius:8px;background:rgba(2,132,199,.08);font-size:.62rem;line-height:1.5;color:var(--label-color);">
                        Otomatis sync: transaksi/laporan, barang, harga & stok, operasional, absensi, stock opname, PO, Goods Receipt, Closing Shift, End of Day, audit, struk, dan tema. Password, daftar akun, session login, serta draft transaksi tidak dikirim.
                    </div>

                    <div style="display:flex;gap:8px;margin-top:13px;">
                        <button id="ldmDisconnectBtn" type="button" class="btn-modal-ok" style="display:none;background:#dc2626;" onclick="LDMDeviceSyncUI.disconnect()">Putuskan Sambungan</button>
                        <button type="button" class="btn-modal-ok" onclick="LDMDeviceSyncUI.close()">Tutup</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const joinInput = modal.querySelector("#ldmJoinCode");
            joinInput.addEventListener("input", () => {
                joinInput.value = displayRoomCode(joinInput.value);
            });
        }

        const cfg = getConfig();
        const serverInput = document.getElementById("ldmSyncServerBase");
        if (serverInput) serverInput.value = cfg.serverBase || defaultServerBase();
        if (cfg.room) showRoomCode(cfg.room);
    }

    function showRoomCode(room) {
        const wrap = document.getElementById("ldmRoomCodeWrap");
        const code = document.getElementById("ldmRoomCode");
        if (!wrap || !code) return;
        code.textContent = displayRoomCode(room);
        wrap.style.display = "block";
    }

    function openModal() {
        installDashboardUI();
        const modal = document.getElementById("ldmDeviceSyncModal");
        if (modal) modal.style.display = "flex";
        const cfg = getConfig();
        const input = document.getElementById("ldmSyncServerBase");
        if (input) input.value = cfg.serverBase || defaultServerBase();
        if (cfg.room) showRoomCode(cfg.room);
    }

    function closeModal() {
        const modal = document.getElementById("ldmDeviceSyncModal");
        if (modal) modal.style.display = "none";
    }

    function renderStatus(detail = {}) {
        const status = detail.status || "disconnected";
        const cfg = detail.config || getConfig();
        const text = document.getElementById("ldmSyncStatusText");
        const peerText = document.getElementById("ldmSyncPeerText");
        const dot = document.getElementById("deviceSyncDot");
        const buttonText = document.getElementById("deviceSyncButtonText");
        const disconnectButton = document.getElementById("ldmDisconnectBtn");

        let label = "Belum terhubung";
        let icon = "⚪";

        if (status === "connecting") { label = "Menghubungkan..."; icon = "🟡"; }
        if (status === "connected") { label = "Terhubung"; icon = "🟢"; }
        if (status === "synced") { label = "Terhubung & tersinkron"; icon = "🟢"; }
        if (status === "reconnecting") { label = "Menyambung ulang..."; icon = "🟡"; }
        if (status === "error") { label = detail.message || "Gagal terhubung"; icon = "🔴"; }

        if (text) text.textContent = label;
        if (peerText) peerText.textContent = "Device terhubung: " + Number(detail.peers || lastPeers || 0);
        if (dot) dot.textContent = icon;
        if (buttonText) buttonText.textContent = (status === "connected" || status === "synced") ? "Device Terhubung" : "Hubungkan Device";
        if (disconnectButton) disconnectButton.style.display = cfg.room ? "block" : "none";
        if (cfg.room) showRoomCode(cfg.room);
    }

    function uiServerBase() {
        const input = document.getElementById("ldmSyncServerBase");
        return normalizeServerBase(input && input.value || defaultServerBase());
    }

    async function copyCode() {
        const cfg = getConfig();
        if (!cfg.room) return;
        const code = displayRoomCode(cfg.room);
        try {
            await navigator.clipboard.writeText(code);
            if (typeof window.tampilkanAlertCustom === "function") {
                window.tampilkanAlertCustom("Tersalin", "Kode sambungan berhasil disalin.", "success");
            }
        } catch (_) {
            window.prompt("Salin kode sambungan:", code);
        }
    }

    window.LDMDeviceSync = {
        connect,
        createRoom,
        joinRoom,
        disconnect,
        autoConnect,
        getConfig,
        getDeviceId,
        collectSnapshot,
        syncKeys: Array.from(SYNC_KEYS)
    };

    window.LDMDeviceSyncUI = {
        open: openModal,
        close: closeModal,
        renderStatus,
        createRoom() {
            const room = createRoom(uiServerBase());
            showRoomCode(room);
        },
        joinRoom() {
            const input = document.getElementById("ldmJoinCode");
            const room = normalizeRoomCode(input && input.value);
            if (room.length !== 8) {
                if (typeof window.tampilkanAlertCustom === "function") {
                    window.tampilkanAlertCustom("Kode Tidak Valid", "Masukkan kode sambungan 8 karakter dari Device A.", "warning");
                }
                return;
            }
            joinRoom(room, uiServerBase());
        },
        disconnect() {
            disconnect(true);
            renderStatus({ status: "disconnected", peers: 0, config: {} });
        },
        copyCode
    };

    document.addEventListener("DOMContentLoaded", () => {
        installDashboardUI();
        setTimeout(autoConnect, 80);
    });
})();
