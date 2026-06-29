const express = require('express');
const path = require('path');
const cron = require('node-cron');
const mongoose = require('mongoose'); // Tambahan library database

const app = express();
app.use(express.json());

// Menggunakan path.join agar file public bisa diakses
app.use(express.static(path.join(__dirname, 'public'))); 

const API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6LKVFBlIaG2bN0an_0i-GhbBT6ResjWfN1fnousol4Xxg";
const MONGO_URI = process.env.MONGO_URI; // Akan kita atur dari Render

// --- SETUP DATABASE MONGODB ---
if (!MONGO_URI) {
    console.error("❌ Peringatan: MONGO_URI belum diatur di Render!");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log('✅ Terhubung ke Cloud Database MongoDB'))
        .catch(err => console.error('❌ Gagal koneksi MongoDB:', err));
}

// Skema Struktur Database di Cloud
const dbSchema = new mongoose.Schema({
    appId: { type: String, default: 'gamenews-bot' },
    topics: { type: [String], default: [
        "E-Sports Update & Meta Hero Terbaru", 
        "Review Teknologi Engine Game 2025", 
        "Fakta dan Rahasia Lore Game AAA"
    ]},
    articles: { type: Array, default: [] },
    dailyGenerated: { type: Number, default: 0 },
    lastRunDate: { type: String, default: () => new Date().toLocaleDateString('id-ID') },
    tgToken: { type: String, default: "" },
    tgChatId: { type: String, default: "" },
    autoPilotOn: { type: Boolean, default: false },
    isBotWorking: { type: Boolean, default: false }
});

const AppState = mongoose.model('AppState', dbSchema);

// Fungsi Mengambil Data dari Cloud Database
async function getDB() {
    let state = await AppState.findOne({ appId: 'gamenews-bot' });
    if (!state) {
        state = await AppState.create({ appId: 'gamenews-bot' });
    }
    return state;
}

// Fungsi Menyimpan Data ke Cloud Database
async function saveDB(state) {
    await state.save();
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
    let db = await getDB();
    
    // Reset limit harian jika berganti hari
    const today = new Date().toLocaleDateString('id-ID');
    if (db.lastRunDate !== today) {
        db.dailyGenerated = 0;
        db.lastRunDate = today;
        await saveDB(db);
    }

    // Validasi Limit
    if (db.dailyGenerated >= 10) return;
    if (db.isBotWorking) return;
    if (db.topics.length === 0) return;

    // Tandai bot sedang sibuk agar tidak double task
    db.isBotWorking = true;
    await saveDB(db);

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

            // Ambil state DB terbaru
            db = await getDB();
            db.articles.push(newArticle);
            db.dailyGenerated++;
            await saveDB(db);
            
            console.log(`[BOT] Sukses generate artikel: ${newArticle.title}`);
            sendTelegramAlert(newArticle, db);
        }

    } catch (error) {
        console.error("[BOT] Error saat generate artikel:", error);
    } finally {
        // Bebaskan status bot
        db = await getDB();
        db.isBotWorking = false;
        await saveDB(db);
    }
}

// Cron Job
cron.schedule('*/30 * * * *', async () => {
    // Pastikan koneksi DB tersedia sebelum check cron
    if (mongoose.connection.readyState !== 1) return; 

    const db = await getDB();
    if (db.autoPilotOn && db.dailyGenerated < 10 && !db.isBotWorking) {
        console.log("[CRON] Auto-Pilot aktif, memicu task riset...");
        generateArticleTask();
    }
});

// --- API ROUTES UNTUK DASHBOARD ---

app.get('/api/state', async (req, res) => {
    try {
        const db = await getDB();
        res.json(db);
    } catch (e) { res.status(500).json({error: "Database error"}); }
});

app.post('/api/force', async (req, res) => {
    const db = await getDB();
    if (db.isBotWorking) return res.status(400).json({ error: "Bot sedang sibuk" });
    if (db.dailyGenerated >= 10) return res.status(400).json({ error: "Limit Harian Tercapai" });
    if (db.topics.length === 0) return res.status(400).json({ error: "Topik kosong" });
    
    generateArticleTask();
    res.json({ message: "Task riset dipaksa mulai." });
});

app.post('/api/settings/autopilot', async (req, res) => {
    const db = await getDB();
    db.autoPilotOn = req.body.status;
    await saveDB(db);
    res.json({ success: true });
});

app.post('/api/settings/telegram', async (req, res) => {
    const db = await getDB();
    db.tgToken = req.body.tgToken;
    db.tgChatId = req.body.tgChatId;
    await saveDB(db);
    res.json({ success: true });
});

app.post('/api/topics/add', async (req, res) => {
    const db = await getDB();
    if (req.body.topic) {
        db.topics.push(req.body.topic);
        await saveDB(db);
    }
    res.json({ success: true });
});

app.post('/api/topics/remove', async (req, res) => {
    const db = await getDB();
    db.topics.splice(req.body.index, 1);
    await saveDB(db);
    res.json({ success: true });
});

app.post('/api/articles/approve', async (req, res) => {
    const db = await getDB();
    const idx = db.articles.findIndex(a => a.id === req.body.id);
    if (idx !== -1) {
        db.articles[idx].content = req.body.content;
        db.articles[idx].status = 'approved';
        await saveDB(db);
    }
    res.json({ success: true });
});

app.post('/api/articles/reject', async (req, res) => {
    const db = await getDB();
    db.articles = db.articles.filter(a => a.id !== req.body.id);
    await saveDB(db);
    res.json({ success: true });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan 24/7 di port ${PORT}`));
