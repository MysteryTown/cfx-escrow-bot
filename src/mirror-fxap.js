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

async function mirrorFxap(cfxPortal, uploads, { mirrorRepo, mirrorToken, mirrorBranch, workspace, sourceRepoForRelative }) {
    if (!uploads.length) {
        console.log('[mirror] No successful uploads; nothing to mirror.');
        return { mirrored: 0, skipped: 0 };
    }
    if (!mirrorRepo || !mirrorToken) {
        throw new Error('mirrorRepo and mirrorToken are required');
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-mirror-'));
    const cloneDir = path.join(tmpRoot, 'mirror');
    const remoteUrl = `https://x-access-token:${mirrorToken}@github.com/${mirrorRepo}.git`;

    console.log(`[mirror] Cloning ${mirrorRepo} → ${cloneDir}`);
    try {
        git(['clone', '--branch', mirrorBranch, '--single-branch', remoteUrl, cloneDir], { silent: true });
    } catch {
        console.log(`[mirror] Branch ${mirrorBranch} not found; initializing fresh`);
        fs.mkdirSync(cloneDir, { recursive: true });
        git(['init', '-b', mirrorBranch], { cwd: cloneDir });
        git(['remote', 'add', 'origin', remoteUrl], { cwd: cloneDir });
    }

    git(['config', 'user.name', 'github-actions[bot]'], { cwd: cloneDir });
    git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: cloneDir });

    let mirrored = 0;
    const errors = [];

    for (const up of uploads) {
        try {
            console.log(`[mirror] ${up.resource}: downloading pack...`);
            const pack = await cfxPortal.downloadPack(up.assetId);

            const relPath = path.relative(workspace, up.resourceDir);
            const targetDir = path.join(cloneDir, relPath);
            console.log(`[mirror] ${up.resource}: extracting to ${relPath}`);
            const { entryCount, strippedPrefix } = extractPackTo(pack.zipBuffer, targetDir, up.resource);
            console.log(`[mirror] ${up.resource}: wrote ${entryCount} files${strippedPrefix ? ` (stripped "${strippedPrefix}" prefix)` : ''}`);
            mirrored++;
        } catch (e) {
            console.error(`[mirror] FAIL ${up.resource}: ${e.message}`);
            errors.push({ resource: up.resource, error: e.message });
        }
    }

    git(['add', '-A'], { cwd: cloneDir });
    const status = git(['status', '--porcelain'], { cwd: cloneDir, silent: true });
    if (!status.trim()) {
        console.log('[mirror] No changes after extraction; skipping commit.');
        rmrf(tmpRoot);
        return { mirrored, skipped: uploads.length - mirrored, errors };
    }

    const msg = `chore(escrow): sync FXAP for ${uploads.map(u => u.resource).join(', ')}\n\n[skip ci]`;
    git(['commit', '-m', msg], { cwd: cloneDir });
    console.log(`[mirror] Pushing to ${mirrorRepo}:${mirrorBranch}`);
    git(['push', 'origin', `HEAD:${mirrorBranch}`], { cwd: cloneDir });

    rmrf(tmpRoot);
    return { mirrored, skipped: uploads.length - mirrored, errors };
}

module.exports = { mirrorFxap, extractPackTo };
