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

// 1. LAAD ALLE 6 DE FINGERPRINT DATABASE BESTANDEN IN
const tracks = [
    { name: 'Day 1', file: 'day1_fingerprint_new.json' },
    { name: 'Day 2', file: 'day2_fingerprint_new.json' },
    { name: 'Day 3', file: 'day3_fingerprint_new.json' },
    { name: 'Day 4', file: 'day4_fingerprint_new.json' },
    { name: 'Day 5', file: 'day5_fingerprint_new.json' },
    { name: 'Day 6', file: 'day6_fingerprint_new.json' }
];

let fingerprintDb = [];

function loadDatabases() {
    fingerprintDb = [];
    tracks.forEach(trackInfo => {
        const fullPath = path.join(__dirname, trackInfo.file);
        if (fs.existsSync(fullPath)) {
            try {
                const raw = fs.readFileSync(fullPath, 'utf8');
                const parsed = JSON.parse(raw);
                const hashes = Array.isArray(parsed) ? parsed : (parsed.fingerprint || parsed.hashes);
                const duration = parsed.duration || 0;

                if (hashes && hashes.length > 0) {
                    fingerprintDb.push({
                        name: trackInfo.name,
                        duration: duration,
                        hashes: hashes,
                        // Dynamische tijdsstap per hash:
                        timeStep: duration > 0 ? (duration / hashes.length) : 0.12383975
                    });
                    console.log(`[DB LOADED] ${trackInfo.name} (${hashes.length} hashes, ${duration}s)`);
                }
            } catch (e) {
                console.error(`[DB ERROR] Fout bij laden van ${trackInfo.file}:`, e.message);
            }
        } else {
            console.warn(`[DB MISSING] Bestand niet gevonden: ${trackInfo.file}`);
        }
    });
}

// Laad databases direct bij opstarten
loadDatabases();

app.get('/api/match', (req, res) => {
    res.json({ 
        status: "online", 
        loadedTracks: fingerprintDb.map(d => d.name),
        message: "Render multi-track backend werkt!" 
    });
});

app.post('/api/match', upload.single('audio'), (req, res) => {
    console.log("--> WAV Audio verzoek ontvangen van mobiel!");

    if (!req.file) {
        return res.status(400).json({ match: false, error: 'Geen audio bestand ontvangen' });
    }

    const rawPath = req.file.path;
    const inputWav = rawPath + '_input.wav';

    try {
        fs.renameSync(rawPath, inputWav);
    } catch (e) {
        console.error("Hernoemen mislukt:", e);
    }

    if (fingerprintDb.length === 0) {
        if (fs.existsSync(inputWav)) fs.unlinkSync(inputWav);
        return res.status(500).json({ match: false, error: 'Geen enkele JSON fingerprint database geladen op server' });
    }

    const wavSize = fs.statSync(inputWav).size;
    console.log(`WAV ontvangen (${wavSize} bytes). Ingebouwde FFmpeg Chromaprint berekenen...`);

    const ffmpegCmd = `ffmpeg -y -i "${inputWav}" -f chromaprint -fp_format raw -`;

    exec(ffmpegCmd, { encoding: 'buffer', maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
        if (fs.existsSync(inputWav)) fs.unlinkSync(inputWav);

        try {
            const liveFp = [];

            if (Buffer.isBuffer(stdout) && stdout.length >= 4) {
                for (let i = 0; i <= stdout.length - 4; i += 4) {
                    liveFp.push(stdout.readInt32LE(i));
                }
            }

            console.log(`FFmpeg binaire live hashes geëxtraheerd: ${liveFp.length}`);

            if (liveFp.length < 10) {
                return res.json({ match: false, score: 0, error: 'Te weinig audio-kenmerken gedetecteerd. Probeer opnieuw.' });
            }

            const liveLen = liveFp.length;
            let allCandidates = [];

            // 2. SCAN DOOR ALLES 6 DE TRACKS IN HET GEHEUGEN
            fingerprintDb.forEach(trackDb => {
                const dbFp = trackDb.hashes;
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

                        if (bitMatches >= 22) {
                            matches++;
                        }
                    }

                    if (tested > 0) {
                        const score = (matches / tested) * 100;
                        allCandidates.push({
                            trackName: trackDb.name,
                            index: i,
                            score: score,
                            matches: matches,
                            tested: tested,
                            timeStep: trackDb.timeStep
                        });
                    }
                }
            });

            // Sorteer op aantal matches en score
            allCandidates.sort((a, b) => (b.matches - a.matches) || (b.score - a.score));

            const topMatch = allCandidates[0] || { trackName: 'Unknown', index: 0, score: 0, matches: 0, timeStep: 0.123 };
            const bestIndex = topMatch.index;
            const score = Math.round(topMatch.score);

            // Dynamische tijdcodeberekening
            const timecodeSeconds = bestIndex * topMatch.timeStep;
            
            // STRENGERE CRITERIA VOOR MATCH
            const isMatch = topMatch.matches >= Math.floor(liveLen * 0.30) && score >= 35;

            const minutes = Math.floor(timecodeSeconds / 60);
            const seconds = Math.floor(timecodeSeconds % 60).toString().padStart(2, '0');

            console.log(`--- MATCH RESULTATEN ---`);
            console.log(`Beste Match: ${topMatch.trackName} op ${minutes}:${seconds} (${topMatch.matches}/${topMatch.tested} matches, Score: ${score}%)`);

            if (!isMatch) {
                console.log(`Geen overtuigende match. Beste was ${topMatch.trackName} met ${score}% score.`);
                return res.json({
                    match: false,
                    score: score,
                    error: 'Geen duidelijke overeenkomst gevonden. Zorg dat de audio goed hoorbaar is.'
                });
            }

            // AANSPRAAK MET FRONTEND: Stuur ook de 'track' naam mee!
            res.json({
                match: true,
                track: topMatch.trackName,
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
app.listen(PORT, () => console.log(`Multi-Track Receiver Server draait op poort ${PORT}`));
