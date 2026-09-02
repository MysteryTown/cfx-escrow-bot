const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    escrowResource,
    isAssetUnavailable,
    isMaxVersionsReached,
    readEscrowMarker,
} = require('../src/escrow-resource');

function maxVersionsError() {
    const error = new Error('Request failed with status code 409');
    error.response = {
        status: 409,
        data: {
            error: 'asset has reached the maximum number of versions',
            error_code: 'MAX_VERSIONS_REACHED',
        },
    };
    return error;
}

function unavailableAssetError() {
    const error = new Error('Request failed with status code 500');
    error.code = 'CFX_ASSET_UNAVAILABLE';
    error.response = {
        status: 500,
        data: { error: 'failed to get asset' },
    };
    return error;
}

function makeResource(assetId = 1061403) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-rotation-'));
    const resourceDir = path.join(root, 'mt_smallresources');
    fs.mkdirSync(resourceDir);
    fs.writeFileSync(path.join(resourceDir, '.escrow'), `${assetId}\n`);
    fs.writeFileSync(path.join(resourceDir, 'fxmanifest.lua'), "fx_version 'cerulean'\n");
    return { root, resourceDir };
}

test('recognizes the CFX maximum-versions response', () => {
    assert.equal(isMaxVersionsReached(maxVersionsError()), true);
    const unrelated = new Error('conflict');
    unrelated.response = { status: 409, data: { error_code: 'OTHER_CONFLICT' } };
    assert.equal(isMaxVersionsReached(unrelated), false);
});

test('deprecates an exhausted pinned asset and records its replacement', async (t) => {
    const { root, resourceDir } = makeResource();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const calls = [];
    const portal = {
        async findAssetWithVersions(assetId) {
            calls.push(['findAssetWithVersions', assetId]);
            return { id: assetId, name: 'mt_smallresources' };
        },
        async uploadAsset(assetId) {
            calls.push(['uploadAsset', assetId]);
            throw maxVersionsError();
        },
        async deleteAsset(assetId) {
            calls.push(['deleteAsset', assetId]);
        },
        async createAsset(name) {
            calls.push(['createAsset', name]);
            return {
                id: 2000001,
                versionId: 3000001,
                chunkSize: 8388608,
                chunkCount: 1,
            };
        },
        async uploadChunksAndComplete(assetId, versionId) {
            calls.push(['uploadChunksAndComplete', assetId, versionId]);
        },
    };

    const result = await escrowResource(portal, resourceDir);

    assert.equal(result.action, 'rotated');
    assert.equal(result.previousAssetId, 1061403);
    assert.equal(result.assetId, 2000001);
    assert.equal(readEscrowMarker(resourceDir).assetId, 2000001);
    assert.deepEqual(calls.map(call => call[0]), [
        'findAssetWithVersions',
        'uploadAsset',
        'deleteAsset',
        'createAsset',
        'uploadChunksAndComplete',
    ]);
});

test('recovers an unavailable marker using an existing replacement asset', async (t) => {
    const { root, resourceDir } = makeResource();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const calls = [];
    let uploadCount = 0;
    const portal = {
        async findAssetWithVersions(assetId) {
            calls.push(['findAssetWithVersions', assetId]);
            return { id: assetId, name: 'mt_smallresources' };
        },
        async uploadAsset(assetId) {
            calls.push(['uploadAsset', assetId]);
            uploadCount++;
            if (uploadCount === 1) throw unavailableAssetError();
        },
        async deleteAsset(assetId) {
            calls.push(['deleteAsset', assetId]);
        },
        async findAssetByName(name) {
            calls.push(['findAssetByName', name]);
            return { id: 2000003, name };
        },
    };

    const result = await escrowResource(portal, resourceDir);

    assert.equal(result.action, 'recovered');
    assert.equal(result.previousAssetId, 1061403);
    assert.equal(result.assetId, 2000003);
    assert.equal(readEscrowMarker(resourceDir).assetId, 2000003);
    assert.deepEqual(calls, [
        ['findAssetWithVersions', 1061403],
        ['uploadAsset', 1061403],
        ['deleteAsset', 1061403],
        ['findAssetByName', 'mt_smallresources'],
        ['uploadAsset', 2000003],
    ]);
});

test('recognizes an unavailable CFX asset', () => {
    assert.equal(isAssetUnavailable(unavailableAssetError()), true);
    const unrelated = new Error('internal server error');
    unrelated.response = { status: 500, data: { error: 'database timeout' } };
    assert.equal(isAssetUnavailable(unrelated), false);
});

test('replaces an unavailable pinned asset and records its replacement', async (t) => {
    const { root, resourceDir } = makeResource();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const calls = [];
    const portal = {
        async findAssetWithVersions(assetId) {
            calls.push(['findAssetWithVersions', assetId]);
            return { id: assetId, name: 'mt_smallresources' };
        },
        async uploadAsset(assetId) {
            calls.push(['uploadAsset', assetId]);
            throw unavailableAssetError();
        },
        async deleteAsset(assetId) {
            calls.push(['deleteAsset', assetId]);
        },
        async findAssetByName(name) {
            calls.push(['findAssetByName', name]);
            return null;
        },
        async createAsset(name) {
            calls.push(['createAsset', name]);
            return {
                id: 2000002,
                versionId: 3000002,
                chunkSize: 8388608,
                chunkCount: 1,
            };
        },
        async uploadChunksAndComplete(assetId, versionId) {
            calls.push(['uploadChunksAndComplete', assetId, versionId]);
        },
    };

    const result = await escrowResource(portal, resourceDir);

    assert.equal(result.action, 'replaced');
    assert.equal(result.previousAssetId, 1061403);
    assert.equal(result.assetId, 2000002);
    assert.equal(readEscrowMarker(resourceDir).assetId, 2000002);
    assert.deepEqual(calls.map(call => call[0]), [
        'findAssetWithVersions',
        'uploadAsset',
        'deleteAsset',
        'findAssetByName',
        'createAsset',
        'uploadChunksAndComplete',
    ]);
});

test('does not delete an asset for an unrelated upload conflict', async (t) => {
    const { root, resourceDir } = makeResource();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    let deleted = false;
    const conflict = new Error('Request failed with status code 409');
    conflict.response = { status: 409, data: { error_code: 'OTHER_CONFLICT' } };
    const portal = {
        async findAssetWithVersions(assetId) {
            return { id: assetId, name: 'mt_smallresources' };
        },
        async uploadAsset() {
            throw conflict;
        },
        async deleteAsset() {
            deleted = true;
        },
    };

    await assert.rejects(() => escrowResource(portal, resourceDir), conflict);
    assert.equal(deleted, false);
    assert.equal(readEscrowMarker(resourceDir).assetId, 1061403);
});

test('does not upload to a pinned asset owned by another resource', async (t) => {
    const { root, resourceDir } = makeResource();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const calls = [];
    const portal = {
        async findAssetWithVersions(assetId) {
            calls.push(['findAssetWithVersions', assetId]);
            return { id: assetId, name: 'mt_other_resource' };
        },
        async findAssetByName(name) {
            calls.push(['findAssetByName', name]);
            return { id: 2000004, name };
        },
        async uploadAsset(assetId) {
            calls.push(['uploadAsset', assetId]);
        },
    };

    const result = await escrowResource(portal, resourceDir);

    assert.equal(result.action, 'reuploaded');
    assert.equal(result.assetId, 2000004);
    assert.equal(readEscrowMarker(resourceDir).assetId, 2000004);
    assert.deepEqual(calls, [
        ['findAssetWithVersions', 1061403],
        ['findAssetByName', 'mt_smallresources'],
        ['uploadAsset', 2000004],
    ]);
});
