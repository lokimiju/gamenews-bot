const express = require('express');
const path = require('path');
const cron = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// Menggunakan path.join agar file public bisa diakses
app.use(express.static(path.join(__dirname, 'public'))); 

const API_KEY = process.env.GEMINI_API_KEY;
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

async function getDB() {
    let state = await AppState.findOne({ appId: 'gamenews-bot' });
    if (!state) state = await AppState.create({ appId: 'gamenews-bot' });
    return state;
}

async function saveDB(state) {
    await state.save();
}

async function sendTelegramAlert(article, db) {
    if (!db.tgToken || !db.tgChatId) return;
    const msg = `🚨 *Artikel Baru Siap Direview!*\n\n*Topik:* ${article.topic}\n*Judul:* ${article.title}\n\nBot telah selesai meriset secara mendalam. Silakan buka dashboard.`;
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
        await saveDB(db);
    }

    if (db.dailyGenerated >= 10 || db.isBotWorking || db.topics.length === 0) return;

    db.isBotWorking = true;
    await saveDB(db);

    const topic = db.topics[Math.floor(Math.random() * db.topics.length)];
    console.log(`[BOT] Mulai riset mendalam tentang topik: ${topic}...`);

    try {
        const prompt = `
            Kamu adalah Jurnalis Game Senior dan Analis Industri.
            Tugas: Buatlah artikel MENDALAM hari ini mengenai topik: "${topic}".
            
            ATURAN KETAT (WAJIB DIPATUHI):
            1. FAKTA & DATA: Tulis informasi yang tajam, profesional, dan masuk akal.
            2. PANJANG: Artikel harus berbobot (sekitar 400-500 kata).
            3. FORMAT HTML: Gunakan <h2>, <h3>, <p>, <ul>, <li> untuk styling (JANGAN pakai tanda kutip miring \`\`\`).
            4. KUTIPAN INLINE (PENTING!): Sertakan sumber referensi/kutipan di bawah paragraf menggunakan format ini:
               <div class="inline-source"><a href="#" target="_blank"><i class="fa-solid fa-link"></i> Sumber Referensi Online</a></div>
            
            KEMBALIKAN HANYA OBJEK JSON MURNI SEPERTI INI:
            {
                "title": "Judul Artikel Profesional",
                "content": "Isi artikel lengkap berformat HTML"
            }
        `;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: "Kembalikan HANYA format JSON murni. Dilarang menambah teks basa-basi." }] }
        };

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`Google API error ${response.status}`);
        
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (text) {
            let cleanText = text.replace(/```json/gi, '').replace(/```html/gi, '').replace(/```/g, '').trim();
            const firstBrace = cleanText.indexOf('{');
            const lastBrace = cleanText.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) cleanText = cleanText.substring(firstBrace, lastBrace + 1);

            const jsonResponse = JSON.parse(cleanText);
            
            if(!jsonResponse.title || !jsonResponse.content) throw new Error("JSON tidak valid.");

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
            
            console.log(`[BOT] Sukses menghasilkan artikel: ${newArticle.title}`);
            sendTelegramAlert(newArticle, db);
        } else {
            throw new Error("Respons AI kosong.");
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
    if (db.autoPilotOn && db.dailyGenerated < 10 && !db.isBotWorking) generateArticleTask();
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
    
    generateArticleTask(); // Memicu proses asinkron
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
        db.tgToken = req.body.tgToken || db.tgToken;
        db.tgChatId = req.body.tgChatId || db.tgChatId;
        await saveDB(db);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/topics/add', async (req, res) => {
    const db = await getDB();
    if (req.body.topic) { db.topics.push(req.body.topic); await saveDB(db); }
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

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan 24/7 di port ${PORT}`));
