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

async function createFreshAsset(cfxPortal, resourceDir, folderName, zipBuffer, zipName) {
    console.log(`[escrow] Creating new asset for ${folderName}...`);
    const created = await cfxPortal.createAsset(folderName, zipBuffer, zipName);
    writeEscrowMarker(resourceDir, created.id);
    console.log(`[escrow] Pinned ${folderName} → asset ${created.id} (saved to .escrow before upload)`);
    try {
        await cfxPortal.uploadChunksAndComplete(created.id, created.versionId, zipBuffer, created.chunkSize, created.chunkCount);
        return { resource: folderName, assetId: created.id, action: 'created' };
    } catch (e) {
        const wrapped = new Error(`Asset ${created.id} created but upload failed: ${e.message}. Re-run will resume via re-upload path.`);
        wrapped.assetId = created.id;
        throw wrapped;
    }
}

function isMaxVersionsReached(error) {
    const status = error.response?.status;
    const data = error.response?.data;
    const code = data && typeof data === 'object' ? data.error_code : null;
    const message = data && typeof data === 'object'
        ? data.error
        : typeof data === 'string' ? data : error.message;
    return status === 409 && (
        code === 'MAX_VERSIONS_REACHED'
        || /maximum number of versions/i.test(message || '')
    );
}

function isAssetUnavailable(error) {
    const status = error.response?.status;
    const data = error.response?.data;
    const message = data && typeof data === 'object'
        ? data.error
        : typeof data === 'string' ? data : error.message;
    return error.code === 'CFX_ASSET_UNAVAILABLE'
        || (status === 500 && /failed to get asset/i.test(message || ''));
}

async function rotateExhaustedAsset(cfxPortal, resourceDir, folderName, oldAssetId, zipBuffer, zipName) {
    console.warn(`[escrow] Asset ${oldAssetId} reached the version limit; deprecating it and creating a replacement`);
    await cfxPortal.deleteAsset(oldAssetId);
    const replacement = await createFreshAsset(cfxPortal, resourceDir, folderName, zipBuffer, zipName);
    return {
        ...replacement,
        action: 'rotated',
        previousAssetId: oldAssetId,
    };
}

async function replaceUnavailableAsset(cfxPortal, resourceDir, folderName, oldAssetId, zipBuffer, zipName) {
    console.warn(`[escrow] Asset ${oldAssetId} is unavailable; deprecating it and checking for an existing replacement`);
    await cfxPortal.deleteAsset(oldAssetId);

    const existing = await cfxPortal.findAssetByName(folderName);
    if (existing && existing.id !== oldAssetId) {
        console.log(`[escrow] Recovering ${folderName} with existing replacement asset ${existing.id}`);
        try {
            await cfxPortal.uploadAsset(existing.id, zipBuffer, zipName);
            writeEscrowMarker(resourceDir, existing.id);
            return {
                resource: folderName,
                assetId: existing.id,
                action: 'recovered',
                previousAssetId: oldAssetId,
            };
        } catch (error) {
            if (isMaxVersionsReached(error)) {
                return await rotateExhaustedAsset(
                    cfxPortal,
                    resourceDir,
                    folderName,
                    existing.id,
                    zipBuffer,
                    zipName
                );
            }
            if (!isAssetUnavailable(error)) throw error;
            console.warn(`[escrow] Existing replacement asset ${existing.id} is also unavailable; creating a fresh asset`);
        }
    }

    const replacement = await createFreshAsset(cfxPortal, resourceDir, folderName, zipBuffer, zipName);
    return {
        ...replacement,
        action: 'replaced',
        previousAssetId: oldAssetId,
    };
}

async function escrowResource(cfxPortal, resourceDir) {
    const folderName = path.basename(resourceDir);
    const marker = readEscrowMarker(resourceDir);
    if (!marker) throw new Error(`No .escrow marker at ${resourceDir}`);

    console.log(`[escrow] Zipping ${folderName}...`);
    const zipBuffer = await zipResource(resourceDir);
    const zipName = `${folderName}.zip`;
    console.log(`[escrow] ${folderName}: ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    if (marker.assetId) {
        try {
            console.log(`[escrow] Re-uploading to pinned asset ${marker.assetId}`);
            await cfxPortal.uploadAsset(marker.assetId, zipBuffer, zipName);
            writeEscrowMarker(resourceDir, marker.assetId);
            return { resource: folderName, assetId: marker.assetId, action: 'reuploaded' };
        } catch (e) {
            const status = e.response?.status;
            if (isMaxVersionsReached(e)) {
                return await rotateExhaustedAsset(
                    cfxPortal,
                    resourceDir,
                    folderName,
                    marker.assetId,
                    zipBuffer,
                    zipName
                );
            }
            if (isAssetUnavailable(e)) {
                return await replaceUnavailableAsset(
                    cfxPortal,
                    resourceDir,
                    folderName,
                    marker.assetId,
                    zipBuffer,
                    zipName
                );
            }
            if (status !== 404 && status !== 410) throw e;
            console.warn(`[escrow] Pinned asset ${marker.assetId} returned ${status}; falling back to lookup/create`);
        }
    }

    console.log(`[escrow] Looking up existing asset by name: ${folderName}`);
    const existing = await cfxPortal.findAssetByName(folderName);
    if (existing) {
        console.log(`[escrow] Found existing asset ${existing.id}; re-uploading`);
        try {
            await cfxPortal.uploadAsset(existing.id, zipBuffer, zipName);
        } catch (error) {
            if (isMaxVersionsReached(error)) {
                return await rotateExhaustedAsset(
                    cfxPortal,
                    resourceDir,
                    folderName,
                    existing.id,
                    zipBuffer,
                    zipName
                );
            }
            throw error;
        }
        writeEscrowMarker(resourceDir, existing.id);
        return { resource: folderName, assetId: existing.id, action: 'reuploaded' };
    }

    return await createFreshAsset(cfxPortal, resourceDir, folderName, zipBuffer, zipName);
}

module.exports = {
    ESCROW_MARKER,
    readEscrowMarker,
    writeEscrowMarker,
    zipResource,
    findResourcesWithMarker,
    isMaxVersionsReached,
    isAssetUnavailable,
    escrowResource,
};
