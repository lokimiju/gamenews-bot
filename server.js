const express = require('express');
const path = require('path');
const cron = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

const API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI; 

// --- SETUP DATABASE MONGODB ---
if (!MONGO_URI) {
    console.error("❌ Peringatan: MONGO_URI belum diatur di Render!");
} else {
    mongoose.connect(MONGO_URI)
        .then(async () => {
            console.log('✅ Terhubung ke Cloud Database MongoDB');
            const AppState = mongoose.model('AppState');
            // FITUR ANTI-MACET: Reset status nyangkut saat server restart
            await AppState.updateMany({}, { isBotWorking: false, taskStartTime: 0 });
        })
        .catch(err => console.error('❌ Gagal koneksi MongoDB:', err));
}

// Skema Database (Ditambah taskStartTime agar timer tidak hilang saat di-refresh)
const dbSchema = new mongoose.Schema({
    appId: { type: String, default: 'gamenews-bot' },
    topics: { type: [String], default: ["E-Sports Update & Meta Hero", "Review Teknologi Engine Game", "Lore Game AAA"] },
    articles: { type: Array, default: [] },
    dailyGenerated: { type: Number, default: 0 },
    lastRunDate: { type: String, default: () => new Date().toLocaleDateString('id-ID') },
    tgToken: { type: String, default: "" },
    tgChatId: { type: String, default: "" },
    autoPilotOn: { type: Boolean, default: false },
    isBotWorking: { type: Boolean, default: false },
    taskStartTime: { type: Number, default: 0 } 
});

const AppState = mongoose.model('AppState', dbSchema);

async function getDB() {
    let state = await AppState.findOne({ appId: 'gamenews-bot' });
    if (!state) state = await AppState.create({ appId: 'gamenews-bot' });
    
    // AUTO-RELEASE: Jika bot nyangkut lebih dari 3 menit, bebaskan!
    if (state.isBotWorking && state.taskStartTime > 0 && (Date.now() - state.taskStartTime > 180000)) {
        state.isBotWorking = false;
        state.taskStartTime = 0;
        await state.save();
    }
    return state;
}

async function saveDB(state) { await state.save(); }

async function sendTelegramAlert(article, db) {
    if (!db.tgToken || !db.tgChatId) return;
    const msg = `🚨 *Artikel Baru Siap Direview!*\n\n*Topik:* ${article.topic}\n*Judul:* ${article.title}\n\nSilakan cek Dashboard.`;
    try {
        await fetch(`https://api.telegram.org/bot${db.tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: db.tgChatId, text: msg, parse_mode: 'Markdown' })
        });
    } catch (e) { console.error("Gagal mengirim Telegram:", e); }
}

async function generateArticleTask() {
    let db = await getDB();
    const today = new Date().toLocaleDateString('id-ID');
    
    if (db.lastRunDate !== today) {
        db.dailyGenerated = 0;
        db.lastRunDate = today;
    }

    if (db.dailyGenerated >= 10 || db.isBotWorking || db.topics.length === 0) return;

    // KUNCI UTAMA: Tandai bot bekerja dan catat waktu mulainya di Database!
    db.isBotWorking = true;
    db.taskStartTime = Date.now();
    await saveDB(db);

    const topic = db.topics[Math.floor(Math.random() * db.topics.length)];

    try {
        const prompt = `Kamu Jurnalis Game Senior. Buat artikel MENDALAM tentang: "${topic}".
        ATURAN:
        1. Fakta valid & informatif (400-500 kata).
        2. Gunakan tag HTML: <h2>, <h3>, <p>, <ul>, <li>.
        3. Sertakan kutipan referensi: <div class="inline-source"><a href="#"><i class="fa-solid fa-link"></i> Sumber Berita</a></div>
        KEMBALIKAN HANYA JSON MURNI: {"title": "Judul", "content": "Isi HTML"}`;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: "Wajib kembalikan JSON murni." }] }
        };

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`Google API Error ${response.status}`);
        
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (text) {
            let cleanText = text.replace(/```json/gi, '').replace(/```html/gi, '').replace(/```/g, '').trim();
            const firstBrace = cleanText.indexOf('{');
            const lastBrace = cleanText.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) cleanText = cleanText.substring(firstBrace, lastBrace + 1);

            const jsonResponse = JSON.parse(cleanText);
            
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
            db.isBotWorking = false; // Matikan status bekerja
            db.taskStartTime = 0;    // Reset timer di database
            await saveDB(db);
            
            sendTelegramAlert(newArticle, db);
        } else {
            throw new Error("Respons AI Kosong");
        }
    } catch (error) {
        console.error("❌ Gagal membuat artikel:", error.message);
        db = await getDB();
        db.isBotWorking = false; // Pastikan status dikembalikan jika error
        db.taskStartTime = 0;
        await saveDB(db);
    }
}

cron.schedule('*/30 * * * *', async () => {
    if (mongoose.connection.readyState !== 1) return; 
    const db = await getDB();
    if (db.autoPilotOn && db.dailyGenerated < 10 && !db.isBotWorking) generateArticleTask();
});

// --- API ROUTES (Menyambungkan UI ke Database) ---
app.get('/api/state', async (req, res) => {
    try { res.json(await getDB()); } catch (e) { res.status(500).json({error: "DB error"}); }
});

app.post('/api/force', async (req, res) => {
    const db = await getDB();
    if (db.isBotWorking) return res.status(400).json({ error: "Bot sibuk" });
    if (db.dailyGenerated >= 10) return res.status(400).json({ error: "Limit Habis" });
    
    generateArticleTask(); // Jalan di background
    res.json({ message: "Dimulai" });
});

app.post('/api/settings/autopilot', async (req, res) => {
    const db = await getDB(); db.autoPilotOn = req.body.status; await saveDB(db); res.json({ success: true });
});

app.post('/api/settings/telegram', async (req, res) => {
    const db = await getDB(); db.tgToken = req.body.tgToken; db.tgChatId = req.body.tgChatId; await saveDB(db); res.json({ success: true });
});

app.post('/api/topics/add', async (req, res) => {
    const db = await getDB(); if (req.body.topic) { db.topics.push(req.body.topic); await saveDB(db); } res.json({ success: true });
});

app.post('/api/topics/remove', async (req, res) => {
    const db = await getDB(); db.topics.splice(req.body.index, 1); await saveDB(db); res.json({ success: true });
});

app.post('/api/articles/approve', async (req, res) => {
    const db = await getDB();
    const idx = db.articles.findIndex(a => a.id === req.body.id);
    if (idx !== -1) { db.articles[idx].content = req.body.content; db.articles[idx].status = 'approved'; await saveDB(db); }
    res.json({ success: true });
});

app.post('/api/articles/reject', async (req, res) => {
    const db = await getDB(); db.articles = db.articles.filter(a => a.id !== req.body.id); await saveDB(db); res.json({ success: true });
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan 24/7 di port ${PORT}`));
