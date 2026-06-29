const express = require('express');
const path = require('path');
const cron = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// Menggunakan path.join agar file public bisa diakses
app.use(express.static(path.join(__dirname, 'public'))); 

const API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6LKVFBlIaG2bN0an_0i-GhbBT6ResjWfN1fnousol4Xxg";
const MONGO_URI = process.env.MONGO_URI; 

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
        "Review Teknologi Engine Game", 
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
                `Bot telah selesai meriset secara mendalam. Silakan buka dashboard.`;
    
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

    // Tandai bot sedang sibuk
    db.isBotWorking = true;
    await saveDB(db);

    const topic = db.topics[Math.floor(Math.random() * db.topics.length)];
    console.log(`[BOT] Miwiti riset kanthi jero babagan topik: ${topic}...`);

    try {
        const prompt = `
            Sampeyan minangka Jurnalis Game Senior lan Analis Industri (Esports, Meta, Tech, Updates).
            Tugas: Tindakake riset JERO ing internet dina iki babagan topik: "${topic}".
            
            ATURAN KETAT (WAJIB DITURUTI):
            1. FAKTA & DATA VALID: Aja nganggo opini tanpa dhasar, gosip, utawa hoax. Kudu saka info anyar sing nyata.
            2. SUMBER: DILARANG nggunakake Wikipedia. Golek info saka situs web resmi game, IGN, Polygon, utawa situs sing bisa dipercaya liyane.
            3. DAWA: Artikel kudu PAS antarane 500 nganti 600 tembung. Tindakake eksplorasi detail supaya dawane kecukupan.
            4. KEASLIAN: Aja nggunakake tembung cithakan. Gawe asli, profesional, lan landhep.
            5. FORMAT HTML: Gunakake <h2>, <h3>, <p>, <ul>, <li>, <strong> kanggo gaya. Aja nggunakake markdown backticks.
            6. KUTIPAN INLINE (PENTING!): Kanggo saben data, fakta, utawa paragraf penting, WAJIB nyertakake sumber kutipan ing ngisore nggunakake tag HTML persis kaya iki:
               <div class="inline-source"><a href="URL_SUMBER_ASLI" target="_blank"><i class="fa-solid fa-link"></i> Sumber: Jeneng Website / Irah-irahan Referensi</a></div>
            
            BALIKAKE MUNG JSON MURNI KANTHI STRUKTUR IKI:
            {
                "title": "Irah-irahan Artikel Profesional & Click-Worthy (Tanpa Tag)",
                "content": "Isi artikel format HTML jangkep karo elemen .inline-source miturut aturan ing dhuwur."
            }
        `;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            // PERBAIKAN: Format yang benar untuk tool Google Search di API Gemini
            tools: [{ googleSearch: {} }], 
            systemInstruction: { parts: [{ text: "Wenehi format JSON murni sing bisa diparse." }] },
            generationConfig: { responseMimeType: "application/json" }
        };

        // PERBAIKAN: Menggunakan model gemini-1.5-pro-latest yang lebih stabil dengan tools
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errData = await response.text();
            throw new Error(`Google API error ${response.status}: ${errData}`);
        }

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

            db = await getDB();
            db.articles.push(newArticle);
            db.dailyGenerated++;
            await saveDB(db);
            
            console.log(`[BOT] Sukses generate artikel: ${newArticle.title}`);
            sendTelegramAlert(newArticle, db);
        } else {
            throw new Error("Format respons dari AI kosong atau tidak sesuai.");
        }

    } catch (error) {
        console.error("❌ [BOT ERROR] Gagal membuat artikel:", error.message);
    } finally {
        db = await getDB();
        db.isBotWorking = false;
        await saveDB(db);
    }
}

cron.schedule('*/30 * * * *', async () => {
    if (mongoose.connection.readyState !== 1) return; 
    const db = await getDB();
    if (db.autoPilotOn && db.dailyGenerated < 10 && !db.isBotWorking) {
        generateArticleTask();
    }
});

// --- API ROUTES ---
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
    try {
        const db = await getDB();
        db.tgToken = req.body.tgToken || req.body.botToken || req.body.token || db.tgToken;
        db.tgChatId = req.body.tgChatId || req.body.chatId || db.tgChatId;
        await saveDB(db);
        res.json({ success: true, pesan: "Pengaturan kasil disimpen" });
    } catch (e) {
        res.status(500).json({ success: false, error: "Gagal nyimpen pengaturan" });
    }
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
