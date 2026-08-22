"use strict";

/*
 * LocDailyMar Sync Server
 * HTTP static server + SSE relay, tanpa dependency npm.
 * Jalankan: node sync-server.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const STORE_FILE = path.join(ROOT, "sync-store.json");
const MAX_BODY = 16 * 1024 * 1024;

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

const REPLACE_KEYS = new Set(["headerConfig", "strukConfig"]);
const SYNC_KEYS = new Set([...ARRAY_KEYS, ...REPLACE_KEYS]);

function loadStore() {
    try {
        const value = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
        return value && typeof value === "object" ? value : { rooms: {} };
    } catch (_) {
        return { rooms: {} };
    }
}

const persistent = loadStore();
if (!persistent.rooms || typeof persistent.rooms !== "object") persistent.rooms = {};
const liveRooms = new Map();
let persistTimer = null;

function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        const temp = STORE_FILE + ".tmp";
        fs.writeFileSync(temp, JSON.stringify(persistent, null, 2));
        fs.renameSync(temp, STORE_FILE);
    }, 100);
}

function normalizeRoom(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function safeParse(raw, fallback) {
    try {
        const value = JSON.parse(raw);
        return value == null ? fallback : value;
    } catch (_) {
        return fallback;
    }
}

function hashString(value) {
    return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

function itemIdentity(key, item, index) {
    if (item == null || typeof item !== "object") return "primitive:" + hashString(JSON.stringify(item));

    const pick = (...names) => {
        for (const name of names) {
            const value = item[name];
            if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
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
    (Array.isArray(value) ? value : []).forEach((item, index) => map.set(itemIdentity(key, item, index), item));
    return map;
}

function applyArrayPatch(key, raw, upserts, deletes) {
    const current = safeParse(raw, []);
    const map = arrayMap(key, Array.isArray(current) ? current : []);
    for (const id of Array.isArray(deletes) ? deletes : []) map.delete(String(id));
    for (const entry of Array.isArray(upserts) ? upserts : []) {
        if (entry && entry.id) map.set(String(entry.id), entry.item);
    }
    return JSON.stringify(Array.from(map.values()));
}

function liveRoom(code) {
    if (!liveRooms.has(code)) liveRooms.set(code, { clients: new Set() });
    return liveRooms.get(code);
}

function getRoom(code) {
    const room = normalizeRoom(code);
    if (!persistent.rooms[room]) return null;
    return { code: room, persisted: persistent.rooms[room], live: liveRoom(room) };
}

function createRoom(code, creatorDevice) {
    const room = normalizeRoom(code);
    persistent.rooms[room] = {
        creatorDevice: String(creatorDevice || ""),
        state: {},
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    schedulePersist();
    return getRoom(room);
}

function sseWrite(res, payload) {
    try { res.write("data: " + JSON.stringify(payload) + "\n\n"); } catch (_) {}
}

function broadcast(room, payload) {
    for (const client of room.live.clients) sseWrite(client.res, payload);
}

function announcePeers(room) {
    broadcast(room, { type: "peerCount", peers: room.live.clients.size });
}

function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function jsonResponse(res, status, payload) {
    cors(res);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
}

function readJson(req, callback) {
    let body = "";
    let tooLarge = false;
    req.on("data", chunk => {
        if (tooLarge) return;
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY) {
            tooLarge = true;
            callback(new Error("Payload terlalu besar"));
            req.destroy();
        }
    });
    req.on("end", () => {
        if (tooLarge) return;
        try { callback(null, JSON.parse(body || "{}")); }
        catch (_) { callback(new Error("JSON tidak valid")); }
    });
    req.on("error", error => {
        if (!tooLarge) callback(error);
    });
}

const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json; charset=utf-8"
};

const server = http.createServer((req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch (_) { jsonResponse(res, 400, { message: "URL tidak valid" }); return; }

    if (url.pathname === "/sync/events" && req.method === "GET") {
        const roomCode = normalizeRoom(url.searchParams.get("room"));
        const deviceId = String(url.searchParams.get("device") || "unknown").slice(0, 160);
        const mode = String(url.searchParams.get("mode") || "resume");

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no"
        });
        res.write(": LocDailyMar sync stream\n\n");

        if (roomCode.length !== 8) {
            sseWrite(res, { type: "error", code: "INVALID_ROOM", message: "Kode sambungan tidak valid." });
            res.end();
            return;
        }

        let room = getRoom(roomCode);
        if (mode === "create") {
            if (room && String(room.persisted.creatorDevice || "") !== deviceId) {
                sseWrite(res, { type: "error", code: "ROOM_EXISTS", message: "Kode sudah dipakai. Membuat kode baru..." });
                res.end();
                return;
            }
            if (!room) room = createRoom(roomCode, deviceId);
        } else if (!room) {
            sseWrite(res, { type: "error", code: "ROOM_NOT_FOUND", message: "Kode Device A tidak ditemukan pada Sync Server ini." });
            res.end();
            return;
        }

        const client = { res, deviceId };
        room.live.clients.add(client);
        sseWrite(res, { type: "connected", room: roomCode, mode, peers: room.live.clients.size });

        if (mode !== "create") {
            sseWrite(res, { type: "snapshot", data: room.persisted.state || {}, peers: room.live.clients.size });
        }
        announcePeers(room);

        const heartbeat = setInterval(() => {
            try { res.write(": ping\n\n"); } catch (_) {}
        }, 20000);

        req.on("close", () => {
            clearInterval(heartbeat);
            room.live.clients.delete(client);
            announcePeers(room);
        });
        return;
    }

    if (url.pathname === "/sync/op" && req.method === "POST") {
        readJson(req, (error, body) => {
            if (error) {
                jsonResponse(res, 400, { ok: false, message: error.message });
                return;
            }

            const roomCode = normalizeRoom(body.room);
            const room = getRoom(roomCode);
            if (!room) {
                jsonResponse(res, 404, { ok: false, message: "Room sync tidak ditemukan." });
                return;
            }

            const op = body.operation && typeof body.operation === "object" ? body.operation : {};

            if (op.action === "snapshot") {
                const incoming = op.data && typeof op.data === "object" ? op.data : {};
                const next = {};
                for (const [key, value] of Object.entries(incoming)) {
                    if (!SYNC_KEYS.has(key)) continue;
                    next[key] = value == null ? null : String(value);
                }
                room.persisted.state = next;
                room.persisted.updatedAt = Date.now();
                schedulePersist();
                broadcast(room, { type: "snapshot", data: next, peers: room.live.clients.size });
                jsonResponse(res, 200, { ok: true });
                return;
            }

            const key = String(op.key || "");
            if (!SYNC_KEYS.has(key)) {
                jsonResponse(res, 400, { ok: false, message: "Key tidak diizinkan untuk sync." });
                return;
            }

            const state = room.persisted.state || (room.persisted.state = {});

            if (op.action === "arrayPatch" && ARRAY_KEYS.has(key)) {
                const nextRaw = applyArrayPatch(key, state[key] || "[]", op.upserts, op.deletes);
                state[key] = nextRaw;
                room.persisted.updatedAt = Date.now();
                schedulePersist();
                broadcast(room, { type: "updateKey", key, value: nextRaw, peers: room.live.clients.size });
                jsonResponse(res, 200, { ok: true });
                return;
            }

            if (op.action === "replace") {
                state[key] = op.value == null ? "" : String(op.value);
                room.persisted.updatedAt = Date.now();
                schedulePersist();
                broadcast(room, { type: "updateKey", key, value: state[key], peers: room.live.clients.size });
                jsonResponse(res, 200, { ok: true });
                return;
            }

            if (op.action === "deleteKey") {
                delete state[key];
                room.persisted.updatedAt = Date.now();
                schedulePersist();
                broadcast(room, { type: "deleteKey", key, peers: room.live.clients.size });
                jsonResponse(res, 200, { ok: true });
                return;
            }

            jsonResponse(res, 400, { ok: false, message: "Operasi sync tidak dikenal." });
        });
        return;
    }

    let pathname = decodeURIComponent(url.pathname || "/");
    if (pathname === "/") pathname = "/index.html";

    if (pathname === "/sync-store.json" || pathname.endsWith("/sync-store.json")) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
    }

    const relative = path.normalize(pathname).replace(/^([/\\]*\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    const file = path.resolve(ROOT, relative);
    const rootResolved = path.resolve(ROOT) + path.sep;
    if (file !== path.resolve(ROOT) && !file.startsWith(rootResolved)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.stat(file, (error, stat) => {
        if (error || !stat.isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }
        res.writeHead(200, {
            "Content-Type": mime[path.extname(file).toLowerCase()] || "application/octet-stream",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
        });
        fs.createReadStream(file).pipe(res);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("\nLocDailyMar Sync Server aktif");
    console.log("========================================");
    console.log(`Device A: http://localhost:${PORT}`);
    const networks = os.networkInterfaces();
    for (const list of Object.values(networks)) {
        for (const net of list || []) {
            if (net.family === "IPv4" && !net.internal) {
                console.log(`Device lain: http://${net.address}:${PORT}`);
            }
        }
    }
    console.log("========================================");
    console.log("Buka alamat Device lain pada kedua perangkat bila ingin memakai jaringan LAN.\n");
});
