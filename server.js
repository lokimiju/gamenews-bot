const express = require('express');
const path = require('path');
const cron = require('node-cron');
const mongoose = require('mongoose'); // Tambahan pustaka basis data

const app = express();
app.use(express.json());

// Nggunakake path.join supaya berkas public bisa diakses
app.use(express.static(path.join(__dirname, 'public'))); 

const API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6LKVFBlIaG2bN0an_0i-GhbBT6ResjWfN1fnousol4Xxg";
const MONGO_URI = process.env.MONGO_URI; // Bakal diatur saka Render

// --- PENGATURAN BASIS DATA MONGODB ---
if (!MONGO_URI) {
    console.error("❌ Pènget: MONGO_URI durung diatur ing Render!");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log('✅ Kasambung menyang Basis Data Cloud MongoDB'))
        .catch(err => console.error('❌ Gagal nyambung MongoDB:', err));
}

// Skema Struktur Basis Data ing Cloud
const dbSchema = new mongoose.Schema({
    appId: { type: String, default: 'gamenews-bot' },
    topics: { type: [String], default: [
        "Nganyari E-Sports & Meta Hero Paling Anyar", 
        "Ulasan Teknologi Engine Game 2025", 
        "Fakta lan Wadi Lore Game AAA"
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

// Fungsi Njupuk Data saka Basis Data Cloud
async function getDB() {
    let state = await AppState.findOne({ appId: 'gamenews-bot' });
    if (!state) {
        state = await AppState.create({ appId: 'gamenews-bot' });
    }
    return state;
}

// Fungsi Nyimpen Data menyang Basis Data Cloud
async function saveDB(state) {
    await state.save();
}

async function sendTelegramAlert(article, db) {
    if (!db.tgToken || !db.tgChatId) return;
    
    const msg = `🚨 *Artikel Anyar Siap Direview!*\n\n` +
                `*Topik:* ${article.topic}\n` +
                `*Irah-irahan:* ${article.title}\n\n` +
                `Bot wis rampung riset kanthi jero (Server 24/7). Mangga mbukak dashboard.`;
    
    try {
        await fetch(`https://api.telegram.org/bot${db.tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: db.tgChatId, text: msg, parse_mode: 'Markdown' })
        });
    } catch (e) {
        console.error("Gagal ngirim Telegram:", e);
    }
}

async function generateArticleTask() {
    let db = await getDB();
    
    // Baleni watesan saben dina yen ganti dina
    const today = new Date().toLocaleDateString('id-ID');
    if (db.lastRunDate !== today) {
        db.dailyGenerated = 0;
        db.lastRunDate = today;
        await saveDB(db);
    }

    // Validasi Watesan
    if (db.dailyGenerated >= 10) return;
    if (db.isBotWorking) return;
    if (db.topics.length === 0) return;

    // Tandhani bot lagi repot supaya ora tumpuk tugas
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
            tools: [{ "google_search": {} }],
            systemInstruction: { parts: [{ text: "Wenehi format JSON murni sing bisa diparse." }] },
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

            // Njupuk data DB sing paling anyar
            db = await getDB();
            db.articles.push(newArticle);
            db.dailyGenerated++;
            await saveDB(db);
            
            console.log(`[BOT] Sukses nggawe artikel: ${newArticle.title}`);
            sendTelegramAlert(newArticle, db);
        }

    } catch (error) {
        console.error("[BOT] Ana kesalahan nalika nggawe artikel:", error);
    } finally {
        // Bebasake status bot
        db = await getDB();
        db.isBotWorking = false;
        await saveDB(db);
    }
}

// Cron Job
cron.schedule('*/30 * * * *', async () => {
    // Priksa manawa koneksi DB kasedhiya sadurunge mriksa cron
    if (mongoose.connection.readyState !== 1) return; 

    const db = await getDB();
    if (db.autoPilotOn && db.dailyGenerated < 10 && !db.isBotWorking) {
        console.log("[CRON] Auto-Pilot aktif, micu tugas riset...");
        generateArticleTask();
    }
});

// --- RUTE API KANGGO DASHBOARD ---

app.get('/api/state', async (req, res) => {
    try {
        const db = await getDB();
        res.json(db);
    } catch (e) { res.status(500).json({error: "Kesalahan basis data"}); }
});

app.post('/api/force', async (req, res) => {
    const db = await getDB();
    if (db.isBotWorking) return res.status(400).json({ error: "Bot lagi repot" });
    if (db.dailyGenerated >= 10) return res.status(400).json({ error: "Watesan Saben Dina Wis Tekan" });
    if (db.topics.length === 0) return res.status(400).json({ error: "Topik kothong" });
    
    generateArticleTask();
    res.json({ message: "Tugas riset dipeksa diwiwiti." });
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
        // Nganyari token lan chat ID kanthi fleksibel kanggo macem-macem antarmuka
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
app.listen(PORT, () => console.log(`🚀 Server mlaku 24/7 ing port ${PORT}`));
