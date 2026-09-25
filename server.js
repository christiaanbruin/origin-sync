const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['*']
}));

app.options('*', cors());

const upload = multer({ dest: '/tmp/' });
const dbPath = path.join(__dirname, 'day6_fingerprint_clean.json');

app.get('/api/match', (req, res) => {
    res.json({ status: "online", message: "Render backend werkt! Stuur een POST verzoek met audio om te matchen." });
});

app.post('/api/match', upload.single('audio'), (req, res) => {
    console.log("--> Audio verzoek ontvangen van mobiel!");

    if (!req.file) {
        console.error("Geen audio bestand ontvangen in req.file");
        return res.status(400).json({ match: false, error: 'Geen audio bestand ontvangen' });
    }

    const rawPath = req.file.path;
    const inputPath = rawPath + '.webm';

    try {
        fs.renameSync(rawPath, inputPath);
    } catch (e) {
        console.error("Hernoemen van temp bestand mislukt:", e);
    }

    if (!fs.existsSync(dbPath)) {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        console.error("FOUT: day6_fingerprint_clean.json niet gevonden!");
        return res.status(500).json({ match: false, error: 'JSON database ontbreekt op de server' });
    }

    // FFmpeg converteert direct naar ruwe PCM 16-bit Mono (11025Hz) en stuurt via pipe naar fpcalc -raw
    const rawCmd = `ffmpeg -y -i "${inputPath}" -f s16le -ar 11025 -ac 1 - | fpcalc -raw -rate 11025 -channels 1 -length 10 -json -`;

    console.log("FFmpeg + fpcalc raw pipeline uitvoeren...");

    exec(rawCmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
        // Temp bestand altijd direct opruimen
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

        if (err || !stdout) {
            console.error("Pipeline fout:", stderr || err);
            return res.status(500).json({ match: false, error: 'fpcalc kon ruwe stream niet verwerken' });
        }

        try {
            const liveData = JSON.parse(stdout);
            const liveFp = liveData.fingerprint;

            const dbRaw = fs.readFileSync(dbPath, 'utf8');
            const dbData = JSON.parse(dbRaw);
            const dbFp = Array.isArray(dbData) ? dbData : (dbData.fingerprint || dbData.hashes);

            if (!liveFp || !dbFp) {
                console.error("Ongeldige fingerprint structuur");
                return res.status(500).json({ match: false, error: 'Ongeldige fingerprint structuur in JSON' });
            }

            console.log(`Vergelijken: ${liveFp.length} live hashes met ${dbFp.length} DB hashes`);

            let bestIndex = -1;
            let maxMatches = 0;
            const liveLen = liveFp.length;

            for (let i = 0; i <= dbFp.length - liveLen; i++) {
                let matches = 0;
                for (let j = 0; j < liveLen; j++) {
                    const xor = (liveFp[j] ^ dbFp[i + j]) >>> 0;
                    const bitMatches = 32 - countBits(xor);
                    if (bitMatches >= 20) matches++;
                }
                if (matches > maxMatches) {
                    maxMatches = matches;
                    bestIndex = i;
                }
            }

            const score = (maxMatches / liveLen) * 100;
            const timecodeSeconds = bestIndex * 0.12383975;
            const isMatch = score >= 35;

            const minutes = Math.floor(timecodeSeconds / 60);
            const seconds = Math.floor(timecodeSeconds % 60).toString().padStart(2, '0');

            console.log(`Uitslag: Match=${isMatch}, Score=${Math.round(score)}%, Tijd=${minutes}:${seconds}`);

            res.json({
                match: isMatch,
                score: Math.round(score),
                timecode: timecodeSeconds,
                timecode_formatted: `${minutes}:${seconds}`
            });
        } catch (e) {
            console.error("Crash tijdens verwerking van JSON:", e);
            res.status(500).json({ match: false, error: e.message });
        }
    });
});

function countBits(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server draait op poort ${PORT}`));
