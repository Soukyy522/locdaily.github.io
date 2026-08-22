// ==========================================
// 1. DATA DEFAULT PENGATURAN TEMPLATE
// ==========================================
const DEFAULT_SETTINGS = {
    darkMode: false,
    logoUrl: "",
    judulToko: "Safana",
    subJudulToko: "Frozen Food",
    brandFont: "'Poppins', sans-serif",
    appFont: "'Poppins', sans-serif",
    bgPrimary: "#f4f6f9",
    bgSecondary: "#ffffff",
    warnaJudul: "#ffffff",
    warnaOutline: "#d99b00",
    warnaSubJudul: "#ffc107",
    warnaBgHeader: "#0d2240"
};

// Variable penampung sementara untuk preview upload logo
let tempLogoBase64 = null;

// ==========================================
// 2. FUNGSI UNTUK MEMBACA & MENERAPKAN TEMA
// ==========================================
function getSettings() {
    const saved = localStorage.getItem("appSettings");
    return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
}

function applySettings() {
    const settings = getSettings();
    const root = document.documentElement;

    // A. Terapan Dark Mode
    if (settings.darkMode) {
        document.body.classList.add("dark-mode");
    } else {
        document.body.classList.remove("dark-mode");
    }

    // B. Terapan Variabel CSS ke :root sesuai dengan style.css
    root.style.setProperty("--app-font", settings.appFont);
    root.style.setProperty("--brand-font", settings.brandFont);
    root.style.setProperty("--bg-primary", settings.bgPrimary);
    root.style.setProperty("--bg-secondary", settings.bgSecondary);

    // C. Terapan Teks & Gaya Header Toko
    const elJudul = document.getElementById("txtJudulToko");
    if (elJudul) {
        elJudul.innerText = settings.judulToko || "Safana";
        elJudul.style.color = settings.warnaJudul;
        elJudul.style.textShadow = `1px 1px 0px ${settings.warnaOutline}`;
        elJudul.style.fontFamily = settings.brandFont;
    }

    const elSubJudul = document.getElementById("txtSubJudulToko");
    if (elSubJudul) {
        elSubJudul.innerText = settings.subJudulToko || "Frozen Food";
        elSubJudul.style.color = settings.warnaSubJudul;
        elSubJudul.style.fontFamily = settings.brandFont;
    }

    // D. Terapan Warna Latar Header (Banner)
    const elHeaderApp = document.querySelector(".header-app");
    if (elHeaderApp) {
        elHeaderApp.style.backgroundColor = settings.warnaBgHeader;
    }

    // E. Terapan Logo Header
    const elLogoImg = document.getElementById("imgLogoToko");
    if (elLogoImg) {
        if (settings.logoUrl) {
            elLogoImg.src = settings.logoUrl;
            elLogoImg.style.display = "block";
        } else {
            elLogoImg.style.display = "none";
            elLogoImg.src = "";
        }
    }
}

// ==========================================
// 3. FUNGSI KHUSUS MODAL FORM PENGATURAN
// ==========================================

// Mengisi Form dengan Nilai Tersimpan saat Modal Dibuka
function loadFormValues() {
    const settings = getSettings();

    // Dark Mode Toggle Switch
    const elDark = document.getElementById("toggleDarkMode");
    if (elDark) elDark.checked = settings.darkMode;

    // Input Teks Identitas Toko
    const elJudul = document.getElementById("inputJudulToko");
    if (elJudul) elJudul.value = settings.judulToko;

    const elSubJudul = document.getElementById("inputSubJudulToko");
    if (elSubJudul) elSubJudul.value = settings.subJudulToko;

    // Pilihan Font
    const elBrandFont = document.getElementById("selectBrandFontFamily");
    if (elBrandFont) elBrandFont.value = settings.brandFont;

    const elAppFont = document.getElementById("selectFontFamily");
    if (elAppFont) elAppFont.value = settings.appFont;

    // Color Pickers
    const elWarnaJudul = document.getElementById("inputWarnaJudul");
    if (elWarnaJudul) elWarnaJudul.value = settings.warnaJudul;

    const elWarnaOutline = document.getElementById("inputWarnaOutline");
    if (elWarnaOutline) elWarnaOutline.value = settings.warnaOutline;

    const elWarnaSubJudul = document.getElementById("inputWarnaSubJudul");
    if (elWarnaSubJudul) elWarnaSubJudul.value = settings.warnaSubJudul;

    const elWarnaHeader = document.getElementById("inputWarnaBgHeader");
    if (elWarnaHeader) elWarnaHeader.value = settings.warnaBgHeader;

    const elBgPrimary = document.getElementById("inputBgPrimary");
    if (elBgPrimary) elBgPrimary.value = settings.bgPrimary;

    const elBgSecondary = document.getElementById("inputBgSecondary");
    if (elBgSecondary) elBgSecondary.value = settings.bgSecondary;

    // Logo Preview State
    tempLogoBase64 = settings.logoUrl;
    renderLogoPreview(settings.logoUrl);
}

// Mengambil Data Langsung dari Seluruh Input Form
function getFormData() {
    return {
        darkMode: document.getElementById("toggleDarkMode")?.checked || false,
        logoUrl: tempLogoBase64 !== null ? tempLogoBase64 : (getSettings().logoUrl || ""),
        judulToko: document.getElementById("inputJudulToko")?.value || "Safana",
        subJudulToko: document.getElementById("inputSubJudulToko")?.value || "Frozen Food",
        brandFont: document.getElementById("selectBrandFontFamily")?.value || "'Poppins', sans-serif",
        appFont: document.getElementById("selectFontFamily")?.value || "'Poppins', sans-serif",
        bgPrimary: document.getElementById("inputBgPrimary")?.value || "#f4f6f9",
        bgSecondary: document.getElementById("inputBgSecondary")?.value || "#ffffff",
        warnaJudul: document.getElementById("inputWarnaJudul")?.value || "#ffffff",
        warnaOutline: document.getElementById("inputWarnaOutline")?.value || "#d99b00",
        warnaSubJudul: document.getElementById("inputWarnaSubJudul")?.value || "#ffc107",
        warnaBgHeader: document.getElementById("inputWarnaBgHeader")?.value || "#0d2240"
    };
}

// Fungsi Realtime Live Preview Saat Mengubah Warna/Font/Input
function previewRealtimeTheme() {
    const currentData = getFormData();
    const root = document.documentElement;

    // Terapkan ke CSS root
    root.style.setProperty("--app-font", currentData.appFont);
    root.style.setProperty("--brand-font", currentData.brandFont);
    root.style.setProperty("--bg-primary", currentData.bgPrimary);
    root.style.setProperty("--bg-secondary", currentData.bgSecondary);

    // Terapkan ke Dark Mode
    if (currentData.darkMode) {
        document.body.classList.add("dark-mode");
    } else {
        document.body.classList.remove("dark-mode");
    }

    // Terapkan Teks & Warna Header
    const elJudul = document.getElementById("txtJudulToko");
    if (elJudul) {
        elJudul.innerText = currentData.judulToko;
        elJudul.style.color = currentData.warnaJudul;
        elJudul.style.textShadow = `1px 1px 0px ${currentData.warnaOutline}`;
        elJudul.style.fontFamily = currentData.brandFont;
    }

    const elSubJudul = document.getElementById("txtSubJudulToko");
    if (elSubJudul) {
        elSubJudul.innerText = currentData.subJudulToko;
        elSubJudul.style.color = currentData.warnaSubJudul;
        elSubJudul.style.fontFamily = currentData.brandFont;
    }

    const elHeaderApp = document.querySelector(".header-app");
    if (elHeaderApp) {
        elHeaderApp.style.backgroundColor = currentData.warnaBgHeader;
    }

    const elLogoImg = document.getElementById("imgLogoToko");
    if (elLogoImg) {
        if (currentData.logoUrl) {
            elLogoImg.src = currentData.logoUrl;
            elLogoImg.style.display = "block";
        } else {
            elLogoImg.style.display = "none";
        }
    }
}

// ==========================================
// 4. MANAJEMEN UPLOAD & HAPUS LOGO
// ==========================================
function previewUploadLogo(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function (e) {
            tempLogoBase64 = e.target.result;
            renderLogoPreview(tempLogoBase64);
            previewRealtimeTheme();
        };
        reader.readAsDataURL(file);
    }
}

function hapusLogoKustom() {
    tempLogoBase64 = "";
    const inputFile = document.getElementById("inputLogoFile");
    if (inputFile) inputFile.value = "";
    renderLogoPreview("");
    previewRealtimeTheme();
}

function renderLogoPreview(url) {
    const container = document.getElementById("previewLogoContainer");
    const imgModal = document.getElementById("imgPreviewModal");

    if (container && imgModal) {
        if (url) {
            imgModal.src = url;
            container.style.display = "flex";
        } else {
            container.style.display = "none";
            imgModal.src = "";
        }
    }
}

// ==========================================
// 5. KONTROL MODAL (BUKA, TUTUP, SIMPAN)
// ==========================================
function bukaModalSetting() {
    loadFormValues();
    const modal = document.getElementById("modalSettingToko");
    if (modal) {
        modal.style.display = "flex";
    }
}

function tutupModalSetting() {
    const modal = document.getElementById("modalSettingToko");
    if (modal) {
        modal.style.display = "none";
    }
    // Batalkan perubahan sementara dan kembalikan ke data tersimpan
    applySettings();
}

function simpanHeaderToko() {
    const dataToSave = getFormData();
    localStorage.setItem("appSettings", JSON.stringify(dataToSave));
    applySettings();
    tutupModalSetting();
    alert("Pengaturan tampilan berhasil disimpan!");
}

function batalEditHeader() {
    tutupModalSetting();
}

// ==========================================
// 6. INITIALIZATION & EVENT LISTENERS
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    // 1. Jalankan pengaturn awal
    applySettings();

    // 2. Pasang Listener untuk Realtime Live Preview pada Input Modal
    const modalForm = document.getElementById("modalSettingToko");
    if (modalForm) {
        modalForm.addEventListener("input", previewRealtimeTheme);
        modalForm.addEventListener("change", previewRealtimeTheme);
    }

    // 3. Pasang Event Listener Tutup Modal Saat Klik Area Diluar Modal Content
    const modal = document.getElementById("modalSettingToko");
    if (modal) {
        modal.addEventListener("click", (e) => {
            if (e.target === modal) {
                tutupModalSetting();
            }
        });
    }
});

// Otomatis update jika ada perubahan dari tab/halaman browser lain
window.addEventListener("storage", (event) => {
    if (event.key === "appSettings") {
        applySettings();
    }
});