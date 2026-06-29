const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// PERBAIKAN: Menggunakan path.join agar Render 100% tidak akan "Not Found"
app.use(express.static(path.join(__dirname, 'public'))); 

const DB_FILE = path.join(__dirname, 'database.json');
const API_KEY = process.env.GEMINI_API_KEY || "MASUKKAN_API_KEY_ANDA_DISINI";

// Inisialisasi Database JSON sederhana jika belum ada
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
        topics: [
            "E-Sports Update & Meta Hero Terbaru", 
            "Review Teknologi Engine Game 2025", 
            "Fakta dan Rahasia Lore Game AAA"
        ],
        articles: [],
        dailyGenerated: 0,
        lastRunDate: new Date().toLocaleDateString('id-ID'),
        tgToken: "",
        tgChatId: "",
        autoPilotOn: false,
        isBotWorking: false
    }, null, 2));
}

function getDB() {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

async function sendTelegramAlert(article, db) {
    if (!db.tgToken || !db.tgChatId) return;
    
    const msg = `🚨 *Artikel Baru Siap Direview!*\n\n` +
                `*Topik:* ${article.topic}\n` +
                `*Judul:* ${article.title}\n\n` +
                `Bot telah selesai meriset secara mendalam (Server 24/7). Silakan buka dashboard.`;
    
    try {
        await fetch(`https://api.telegram.org/bot${db.tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: db.tgChatId, text: msg, parse_mode: 'Markdown' })
        });
    } catch (e) {
        console.error("Gagal mengirim Telegram:", e);
    }
}

async function generateArticleTask() {
    let db = getDB();
    
    // Reset limit harian jika berganti hari
    const today = new Date().toLocaleDateString('id-ID');
    if (db.lastRunDate !== today) {
        db.dailyGenerated = 0;
        db.lastRunDate = today;
        saveDB(db);
    }

    // Validasi Limit
    if (db.dailyGenerated >= 10) return;
    if (db.isBotWorking) return;
    if (db.topics.length === 0) return;

    // Tandai bot sedang sibuk agar tidak double task
    db.isBotWorking = true;
    saveDB(db);

    const topic = db.topics[Math.floor(Math.random() * db.topics.length)];
    console.log(`[BOT] Memulai riset mendalam untuk topik: ${topic}...`);

    try {
        const prompt = `
            Kamu adalah Jurnalis Game Senior dan Analis Industri (Esports, Meta, Tech, Updates).
            Tugas: Lakukan riset MENDALAM di internet hari ini mengenai topik: "${topic}".
            
            ATURAN KETAT (WAJIB DIPATUHI):
            1. FAKTA & DATA VALID: Hindari opini tak berdasar, rumor, atau hoax. Harus dari info terupdate nyata.
            2. SUMBER: DILARANG menggunakan Wikipedia. Cari informasi dari website resmi game, IGN, Polygon, atau situs terpercaya lainnya.
            3. PANJANG: Artikel harus TEPAT antara 500 hingga 600 kata. Lakukan eksplorasi detail agar panjangnya tercapai.
            4. KEASLIAN: Jangan gunakan kata-kata template (misal: "Kesimpulannya", "Halo gamers"). Buat otentik, profesional, dan tajam. Bisa seputar tech engine terbaru atau game rilis tahun ini.
            5. FORMAT HTML: Gunakan <h2>, <h3>, <p>, <ul>, <li>, <strong> untuk styling. Jangan gunakan markdown backticks.
            6. KUTIPAN INLINE (PENTING!): Untuk setiap data, fakta, atau paragraf krusial, WAJIB sertakan sumber kutipan tepat di bawahnya menggunakan tag HTML persis seperti ini:
               <div class="inline-source"><a href="URL_SUMBER_ASLI" target="_blank"><i class="fa-solid fa-link"></i> Sumber: Nama Website / Judul Referensi</a></div>
            
            KEMBALIKAN HANYA JSON MURNI DENGAN STRUKTUR INI:
            {
                "title": "Judul Artikel Profesional & Click-Worthy (Tanpa Tag)",
                "content": "Isi artikel berformat HTML lengkap dengan elemen .inline-source sesuai aturan di atas."
            }
        `;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ "google_search": {} }],
            systemInstruction: { parts: [{ text: "Berikan format JSON murni yang dapat diparse." }] },
            generationConfig: { responseMimeType: "application/json" }
        };

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (text) {
            const jsonResponse = JSON.parse(text);
            const newArticle = {
                id: 'art-' + Date.now().toString(36),
                title: jsonResponse.title,
                content: jsonResponse.content,
                topic: topic,
                status: 'pending',
                date: new Date().toISOString()
            };

            // Ambil state DB terbaru (untuk jaga-jaga ada perubahan selama fetch)
            db = getDB();
            db.articles.push(newArticle);
            db.dailyGenerated++;
            saveDB(db);
            
            console.log(`[BOT] Sukses generate artikel: ${newArticle.title}`);
            sendTelegramAlert(newArticle, db);
        }

    } catch (error) {
        console.error("[BOT] Error saat generate artikel:", error);
    } finally {
        // Bebaskan status bot
        db = getDB();
        db.isBotWorking = false;
        saveDB(db);
    }
}

// Cron Job: Berjalan setiap 30 Menit mengecek apakah bot perlu bekerja
cron.schedule('*/30 * * * *', () => {
    const db = getDB();
    if (db.autoPilotOn && db.dailyGenerated < 10 && !db.isBotWorking) {
        console.log("[CRON] Auto-Pilot aktif, memicu task riset...");
        generateArticleTask();
    }
});

// --- API ROUTES UNTUK DASHBOARD ---

app.get('/api/state', (req, res) => {
    res.json(getDB());
});

app.post('/api/force', async (req, res) => {
    const db = getDB();
    if (db.isBotWorking) return res.status(400).json({ error: "Bot sedang sibuk" });
    if (db.dailyGenerated >= 10) return res.status(400).json({ error: "Limit Harian Tercapai" });
    if (db.topics.length === 0) return res.status(400).json({ error: "Topik kosong" });
    
    // Picu asynchronous
    generateArticleTask();
    res.json({ message: "Task riset dipaksa mulai." });
});

app.post('/api/settings/autopilot', (req, res) => {
    const db = getDB();
    db.autoPilotOn = req.body.status;
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/settings/telegram', (req, res) => {
    const db = getDB();
    db.tgToken = req.body.tgToken;
    db.tgChatId = req.body.tgChatId;
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/topics/add', (req, res) => {
    const db = getDB();
    if (req.body.topic) {
        db.topics.push(req.body.topic);
        saveDB(db);
    }
    res.json({ success: true });
});

app.post('/api/topics/remove', (req, res) => {
    const db = getDB();
    db.topics.splice(req.body.index, 1);
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/articles/approve', (req, res) => {
    const db = getDB();
    const idx = db.articles.findIndex(a => a.id === req.body.id);
    if (idx !== -1) {
        db.articles[idx].content = req.body.content; // Simpan hasil editan user
        db.articles[idx].status = 'approved';
        saveDB(db);
    }
    res.json({ success: true });
});

app.post('/api/articles/reject', (req, res) => {
    const db = getDB();
    db.articles = db.articles.filter(a => a.id !== req.body.id);
    saveDB(db);
    res.json({ success: true });
});

// Route penangkap jika user mencoba akses yang tidak ada, paksa kembali ke index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan 24/7 di port ${PORT}`));
