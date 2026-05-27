const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ESCROW_MARKER = '.escrow';

function readEscrowMarker(resourceDir) {
    const markerPath = path.join(resourceDir, ESCROW_MARKER);
    if (!fs.existsSync(markerPath)) return null;
    const raw = fs.readFileSync(markerPath, 'utf8').trim();
    if (!raw) return { assetId: null, raw: '' };

    if (/^\d+$/.test(raw)) {
        return { assetId: parseInt(raw, 10), raw };
    }
    try {
        const parsed = JSON.parse(raw);
        return { assetId: parsed.id ? parseInt(parsed.id, 10) : null, raw, meta: parsed };
    } catch {
        return { assetId: null, raw };
    }
}

function writeEscrowMarker(resourceDir, assetId, extra = null) {
    const markerPath = path.join(resourceDir, ESCROW_MARKER);
    const existing = readEscrowMarker(resourceDir);
    if (existing && existing.meta) {
        const merged = { ...existing.meta, id: assetId, ...(extra || {}) };
        fs.writeFileSync(markerPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
        return;
    }
    fs.writeFileSync(markerPath, String(assetId) + '\n', 'utf8');
}

function zipResource(resourceDir) {
    return new Promise((resolve, reject) => {
        const folderName = path.basename(resourceDir);
        const chunks = [];
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('data', (chunk) => chunks.push(chunk));
        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') console.warn('[zip]', err.message);
            else reject(err);
        });
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(chunks)));

        archive.glob('**/*', {
            cwd: resourceDir,
            dot: true,
            ignore: ['node_modules/**', '.git/**', '*.zip'],
        }, { prefix: folderName });

        archive.finalize();
    });
}

function findResourcesWithMarker(rootDir, scanPaths = null) {
    const results = [];
    const candidates = scanPaths && scanPaths.length ? scanPaths : [rootDir];

    function walk(dir) {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
        if (fs.existsSync(path.join(dir, ESCROW_MARKER))) {
            results.push(dir);
            return;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            walk(path.join(dir, entry.name));
        }
    }

    for (const c of candidates) walk(path.resolve(c));
    return [...new Set(results)];
}

async function escrowResource(cfxPortal, resourceDir) {
    const folderName = path.basename(resourceDir);
    const marker = readEscrowMarker(resourceDir);
    if (!marker) throw new Error(`No .escrow marker at ${resourceDir}`);

    console.log(`[escrow] Zipping ${folderName}...`);
    const zipBuffer = await zipResource(resourceDir);
    const zipName = `${folderName}.zip`;
    console.log(`[escrow] ${folderName}: ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    let assetId = marker.assetId;
    let action = 'reuploaded';

    if (!assetId) {
        console.log(`[escrow] Looking up existing asset by name: ${folderName}`);
        const existing = await cfxPortal.findAssetByName(folderName);
        if (existing) {
            assetId = existing.id;
            console.log(`[escrow] Found existing asset ${assetId}; will re-upload`);
        } else {
            console.log(`[escrow] No existing asset; creating new...`);
            const created = await cfxPortal.createAndUploadAsset(folderName, zipBuffer, zipName);
            writeEscrowMarker(resourceDir, created.id);
            return { resource: folderName, assetId: created.id, action: 'created' };
        }
    }

    await cfxPortal.uploadAsset(assetId, zipBuffer, zipName);
    writeEscrowMarker(resourceDir, assetId);
    return { resource: folderName, assetId, action };
}

module.exports = {
    ESCROW_MARKER,
    readEscrowMarker,
    writeEscrowMarker,
    zipResource,
    findResourcesWithMarker,
    escrowResource,
};
