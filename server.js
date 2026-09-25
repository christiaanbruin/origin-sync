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

    // Geef het ruwe bestand expliciet de extensie .webm zodat FFmpeg de container snapt
    const rawPath = req.file.path;
    const inputPath = rawPath + '.webm';
    const wavPath = rawPath + '.wav';

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

    // FFmpeg krijgt nu expliciet instructies om het webm/ogg/mp4 formaat om te zetten naar schone 11.025kHz Mono WAV
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -ar 11025 -ac 1 -c:a pcm_s16le "${wavPath}"`;

    exec(ffmpegCmd, (ffmpegErr, ffmpegStdout, ffmpegStderr) => {
        // Ruwe webm opruimen
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

        if (ffmpegErr || !fs.existsSync(wavPath) || fs.statSync(wavPath).size === 0) {
            console.error("FFmpeg conversiefout:", ffmpegStderr || ffmpegErr);
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            return res.status(500).json({ match: false, error: 'Kon audio niet converteren via ffmpeg' });
        }

        console.log(`WAV bestand succesvol aangemaakt (${fs.statSync(wavPath).size} bytes). fpcalc uitvoeren...`);

        // Voer fpcalc uit op de schone WAV
        exec(`fpcalc -json "${wavPath}"`, (fpErr, stdout, stderr) => {
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

            if (fpErr || !stdout) {
                console.error("fpcalc execution error:", fpErr || stderr);
                return res.status(500).json({ match: false, error: 'fpcalc kon audio niet verwerken' });
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
                console.error("Crash tijdens verwerking:", e);
                res.status(500).json({ match: false, error: e.message });
            }
        });
    });
});

function countBits(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server draait op poort ${PORT}`));
