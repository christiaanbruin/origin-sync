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
    res.json({ status: "online", message: "Render backend werkt!" });
});

app.post('/api/match', upload.single('audio'), (req, res) => {
    console.log("--> WAV Audio verzoek ontvangen van mobiel!");

    if (!req.file) {
        return res.status(400).json({ match: false, error: 'Geen audio bestand ontvangen' });
    }

    const rawPath = req.file.path;
    const wavPath = rawPath + '.wav';

    try {
        fs.renameSync(rawPath, wavPath);
    } catch (e) {
        console.error("Hernoemen mislukt:", e);
    }

    if (!fs.existsSync(dbPath)) {
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        return res.status(500).json({ match: false, error: 'JSON database ontbreekt' });
    }

    const wavSize = fs.statSync(wavPath).size;
    console.log(`WAV bestand ontvangen. Grootte: ${wavSize} bytes`);

    // Bereken Chromaprint rechtstreeks over het ontvangen WAV bestand
    const chromaprintCmd = `ffmpeg -i "${wavPath}" -f chromaprint -fp_format raw -`;

    exec(chromaprintCmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

        const combinedOutput = (stdout + "\n" + stderr).trim();

        try {
            let liveFp = [];

            const numberMatch = combinedOutput.match(/(-?\d+,\s*)+-?\d+/);
            if (numberMatch) {
                liveFp = numberMatch[0].split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
            } else {
                const lines = combinedOutput.split('\n');
                for (const line of lines) {
                    if (line.includes(',') && !line.includes('Stream') && !line.includes('encoder')) {
                        const parsed = line.split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
                        if (parsed.length > liveFp.length) {
                            liveFp = parsed;
                        }
                    }
                }
            }

            console.log(`FFmpeg live hashes geëxtraheerd: ${liveFp.length}`);

            const dbRaw = fs.readFileSync(dbPath, 'utf8');
            const dbData = JSON.parse(dbRaw);
            const dbFp = Array.isArray(dbData) ? dbData : (dbData.fingerprint || dbData.hashes);

            if (liveFp.length < 5 || !dbFp) {
                return res.json({ match: false, score: 0, error: 'Te weinig audio-kenmerken gedetecteerd. Speel de CD luider af.' });
            }

            const liveLen = liveFp.length;
            const candidates = [];
            const startIndex = Math.min(80, Math.floor(dbFp.length * 0.02));

            for (let i = startIndex; i <= dbFp.length - liveLen; i++) {
                let matches = 0;
                let tested = 0;

                for (let j = 0; j < liveLen; j++) {
                    const liveVal = liveFp[j] >>> 0;
                    const dbVal = dbFp[i + j] >>> 0;

                    if (liveVal === 0 || dbVal === 0) continue;

                    tested++;
                    const xor = (liveVal ^ dbVal) >>> 0;
                    const bitMatches = 32 - countBits(xor);

                    if (bitMatches >= 18) {
                        matches++;
                    }
                }

                if (tested > 0) {
                    const score = (matches / tested) * 100;
                    candidates.push({ index: i, score: score, matches: matches, tested: tested });
                }
            }

            candidates.sort((a, b) => b.matches - a.matches);

            const topMatch = candidates[0] || { index: 0, score: 0, matches: 0 };
            const bestIndex = topMatch.index;
            const score = Math.round(topMatch.score);

            const timecodeSeconds = bestIndex * 0.12383975;
            const isMatch = topMatch.matches >= Math.floor(liveLen * 0.15);

            const minutes = Math.floor(timecodeSeconds / 60);
            const seconds = Math.floor(timecodeSeconds % 60).toString().padStart(2, '0');

            console.log(`Top 3 Matches in DB:`);
            candidates.slice(0, 3).forEach((c, idx) => {
                const t = c.index * 0.12383975;
                const m = Math.floor(t / 60);
                const s = Math.floor(t % 60).toString().padStart(2, '0');
                console.log(`  #${idx + 1}: Tijd ${m}:${s} (Matches: ${c.matches}/${c.tested}, Score: ${Math.round(c.score)}%)`);
            });

            res.json({
                match: isMatch,
                score: score,
                timecode: timecodeSeconds,
                timecode_formatted: `${minutes}:${seconds}`
            });
        } catch (e) {
            console.error("Crash tijdens verwerking:", e);
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
