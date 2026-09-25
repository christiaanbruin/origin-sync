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

    const ffmpegCmd = `ffmpeg -i "${inputPath}" -f chromaprint -fp_format raw -`;

    exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

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

            console.log(`FFmpeg ontleed. Live hashes: ${liveFp.length}`);

            const dbRaw = fs.readFileSync(dbPath, 'utf8');
            const dbData = JSON.parse(dbRaw);
            const dbFp = Array.isArray(dbData) ? dbData : (dbData.fingerprint || dbData.hashes);

            if (!liveFp.length || !dbFp) {
                console.error("Geen geldige hashes gegenereerd");
                return res.status(500).json({ match: false, error: 'Geen geldige hashes gegenereerd' });
            }

            // Filter nutteloze stilte / nul-hashes
            const validLiveFp = liveFp.filter(h => h !== 0 && h !== -1);
            if (validLiveFp.length === 0) {
                return res.json({ match: false, error: 'Te veel stilte/ruis in opname' });
            }

            let bestIndex = -1;
            let maxMatches = 0;
            const liveLen = liveFp.length;

            // Hamming distance matching met verhoogde drempel (24/32 bits = 75% bitwise match)
            for (let i = 0; i <= dbFp.length - liveLen; i++) {
                let matches = 0;
                for (let j = 0; j < liveLen; j++) {
                    const liveVal = liveFp[j];
                    const dbVal = dbFp[i + j];

                    // Sla stilte-hashes in de DB of Live stream over
                    if (liveVal === 0 || dbVal === 0) continue;

                    const xor = (liveVal ^ dbVal) >>> 0;
                    const bitMatches = 32 - countBits(xor);

                    // Minimaal 24 van de 32 bits moeten identiek zijn
                    if (bitMatches >= 24) {
                        matches++;
                    }
                }

                if (matches > maxMatches) {
                    maxMatches = matches;
                    bestIndex = i;
                }
            }

            const score = (maxMatches / liveLen) * 100;
            const timecodeSeconds = bestIndex >= 0 ? bestIndex * 0.12383975 : 0;
            
            // Drempelwaarde voor een echte match verhoogd naar 25% van alle geteste hashes
            const isMatch = score >= 25 && bestIndex >= 0;

            const minutes = Math.floor(timecodeSeconds / 60);
            const seconds = Math.floor(timecodeSeconds % 60).toString().padStart(2, '0');

            console.log(`Resultaat -> MaxMatches: ${maxMatches}/${liveLen}, Score: ${Math.round(score)}%, Index: ${bestIndex} (${minutes}:${seconds})`);

            res.json({
                match: isMatch,
                score: Math.round(score),
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
