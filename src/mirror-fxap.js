const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

function git(args, opts = {}) {
    return execFileSync('git', args, {
        stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
        encoding: 'utf8',
        ...opts,
    });
}

function rmrf(p) {
    if (!fs.existsSync(p)) return;
    fs.rmSync(p, { recursive: true, force: true });
}

function extractPackTo(zipBuffer, destDir, expectedFolderName) {
    rmrf(destDir);
    fs.mkdirSync(destDir, { recursive: true });

    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    const topLevelDirs = new Set();
    for (const e of entries) {
        const first = e.entryName.split('/')[0];
        if (e.entryName.includes('/') || e.isDirectory) topLevelDirs.add(first);
    }

    const stripPrefix = topLevelDirs.size === 1 && [...topLevelDirs][0] === expectedFolderName
        ? expectedFolderName + '/'
        : null;

    for (const e of entries) {
        if (e.isDirectory) continue;
        let rel = e.entryName;
        if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length);
        if (!rel) continue;
        const out = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, e.getData());
    }
    return { entryCount: entries.filter(e => !e.isDirectory).length, strippedPrefix: stripPrefix };
}

function syncWorkspaceToMirror(workspaceDir, mirrorDir) {
    let filesDeleted = 0, filesCopied = 0;
    for (const entry of fs.readdirSync(mirrorDir)) {
        if (entry === '.git') continue;
        rmrf(path.join(mirrorDir, entry));
        filesDeleted++;
    }
    for (const entry of fs.readdirSync(workspaceDir)) {
        if (entry === '.git') continue;
        const src = path.join(workspaceDir, entry);
        const dest = path.join(mirrorDir, entry);
        fs.cpSync(src, dest, { recursive: true, force: true });
        filesCopied++;
    }
    return { filesDeleted, filesCopied };
}

async function mirrorFxap(cfxPortal, uploads, { mirrorRepo, mirrorToken, mirrorBranch, workspace }) {
    if (!mirrorRepo || !mirrorToken) {
        throw new Error('mirrorRepo and mirrorToken are required');
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-mirror-'));
    const cloneDir = path.join(tmpRoot, 'mirror');
    const remoteUrl = `https://x-access-token:${mirrorToken}@github.com/${mirrorRepo}.git`;

    console.log(`[mirror] Cloning ${mirrorRepo}:${mirrorBranch}`);
    let mirrorIsFresh = false;
    try {
        git(['clone', '--branch', mirrorBranch, '--single-branch', remoteUrl, cloneDir], { silent: true });
    } catch {
        console.log(`[mirror] Branch ${mirrorBranch} not found on ${mirrorRepo}; initializing fresh`);
        fs.mkdirSync(cloneDir, { recursive: true });
        git(['init', '-b', mirrorBranch], { cwd: cloneDir });
        git(['remote', 'add', 'origin', remoteUrl], { cwd: cloneDir });
        mirrorIsFresh = true;
    }

    git(['config', 'user.name', 'github-actions[bot]'], { cwd: cloneDir });
    git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: cloneDir });

    console.log(`[mirror] Syncing full workspace tree → mirror clone`);
    const sync = syncWorkspaceToMirror(workspace, cloneDir);
    console.log(`[mirror] Cleared ${sync.filesDeleted} top-level entries, copied ${sync.filesCopied} from workspace`);

    let mirrored = 0;
    const errors = [];
    for (const up of uploads) {
        try {
            console.log(`[mirror] ${up.resource}: downloading FXAP pack...`);
            const pack = await cfxPortal.downloadPack(up.assetId);
            const relPath = path.relative(workspace, up.resourceDir).split(path.sep).join('/');
            const targetDir = path.join(cloneDir, relPath);
            const { entryCount, strippedPrefix } = extractPackTo(pack.zipBuffer, targetDir, up.resource);
            console.log(`[mirror] ${up.resource}: replaced source at ${relPath} with ${entryCount} FXAP files${strippedPrefix ? ` (stripped "${strippedPrefix}")` : ''}`);
            mirrored++;
        } catch (e) {
            console.error(`[mirror] FAIL ${up.resource}: ${e.message}`);
            errors.push({ resource: up.resource, error: e.message });
        }
    }

    git(['add', '-A'], { cwd: cloneDir });
    const status = git(['status', '--porcelain'], { cwd: cloneDir, silent: true });
    if (!status.trim()) {
        console.log('[mirror] No changes vs current mirror HEAD; skipping commit.');
        rmrf(tmpRoot);
        return { mirrored, skipped: uploads.length - mirrored, errors, noop: true };
    }

    const lines = status.split('\n').filter(Boolean);
    console.log(`[mirror] Changes detected: ${lines.length} entries (first 10):`);
    lines.slice(0, 10).forEach(l => console.log(`  ${l}`));

    const subject = uploads.length
        ? `chore(escrow): sync MT08 + FXAP for ${uploads.map(u => u.resource).join(', ')}`
        : `chore(escrow): sync MT08 source`;
    const msg = `${subject}\n\n[skip ci]`;
    git(['commit', '-m', msg], { cwd: cloneDir });

    console.log(`[mirror] Pushing to ${mirrorRepo}:${mirrorBranch}`);
    const pushArgs = ['push', 'origin', `HEAD:${mirrorBranch}`];
    if (mirrorIsFresh) pushArgs.splice(1, 0, '--force');
    git(pushArgs, { cwd: cloneDir });

    rmrf(tmpRoot);
    return { mirrored, skipped: uploads.length - mirrored, errors };
}

module.exports = { mirrorFxap, extractPackTo };
