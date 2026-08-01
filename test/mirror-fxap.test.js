const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { syncWorkspaceToMirror } = require('../src/mirror-fxap');

test('workspace sync preserves protected resources and updates ordinary files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-sync-test-'));
    const workspace = path.join(root, 'workspace');
    const mirror = path.join(root, 'mirror');
    const protectedPath = 'resources/protected';

    try {
        fs.mkdirSync(path.join(workspace, protectedPath), { recursive: true });
        fs.mkdirSync(path.join(mirror, protectedPath), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'ordinary.txt'), 'new');
        fs.writeFileSync(path.join(workspace, protectedPath, 'client.lua'), 'plaintext');
        fs.writeFileSync(path.join(mirror, 'ordinary.txt'), 'old');
        fs.writeFileSync(path.join(mirror, protectedPath, 'client.lua'), 'encrypted');
        fs.writeFileSync(path.join(mirror, protectedPath, '.fxap'), 'marker');

        syncWorkspaceToMirror(workspace, mirror, [protectedPath]);

        assert.equal(fs.readFileSync(path.join(mirror, 'ordinary.txt'), 'utf8'), 'new');
        assert.equal(fs.readFileSync(path.join(mirror, protectedPath, 'client.lua'), 'utf8'), 'encrypted');
        assert.equal(fs.readFileSync(path.join(mirror, protectedPath, '.fxap'), 'utf8'), 'marker');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('workspace sync deletes removed unprotected paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-delete-test-'));
    const workspace = path.join(root, 'workspace');
    const mirror = path.join(root, 'mirror');

    try {
        fs.mkdirSync(workspace, { recursive: true });
        fs.mkdirSync(path.join(mirror, 'removed'), { recursive: true });
        fs.writeFileSync(path.join(mirror, 'removed', 'old.txt'), 'old');

        syncWorkspaceToMirror(workspace, mirror);

        assert.equal(fs.existsSync(path.join(mirror, 'removed')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
