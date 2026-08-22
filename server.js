const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'database_lokal.json');

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname)); // Melayani file HTML, CSS, JS

// Inisialisasi Database File jika belum ada
if (!fs.existsSync(DB_FILE)) {
    const initialData = {
        barang: [],
        laporan: [],
        headerConfig: {}
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
}

// ------------------- API ENDPOINTS -------------------

// 1. Ambil Seluruh Data Database Lokal
app.get('/api/data', (req, res) => {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        res.status(500).json({ error: "Gagal membaca database lokal" });
    }
});

// 2. Simpan / Update Seluruh Data
app.post('/api/simpan-semua', (req, res) => {
    try {
        const dataBaru = req.body;
        fs.writeFileSync(DB_FILE, JSON.stringify(dataBaru, null, 2));
        res.json({ status: "success", message: "Data berhasil disimpan ke Server Lokal!" });
    } catch (err) {
        res.status(500).json({ error: "Gagal menyimpan ke server" });
    }
});

// 3. Tambah Transaksi Sales Baru (Real-time dari Kasir)
app.post('/api/transaksi', (req, res) => {
    try {
        const transaksiBaru = req.body;
        const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        
        // Masukkan transaksi baru ke array laporan
        dbData.laporan.push(transaksiBaru);
        
        fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
        res.json({ status: "success", message: "Transaksi berhasil dicatat di Server!" });
    } catch (err) {
        res.status(500).json({ error: "Gagal mencatat transaksi" });
    }
});

// Jalankan Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`===================================================`);
    console.log(`🚀 SERVER LOKAL SAFANAPOS BERJALAN!`);
    console.log(`Akses dari PC Server : http://localhost:${PORT}/kasir.html`);
    console.log(`===================================================`);
});