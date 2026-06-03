const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');
const { findResourcesWithMarker, readEscrowMarker } = require('./escrow-resource');

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

const MIRROR_EXCLUDE_TOP = new Set(['.git']);
const MIRROR_EXCLUDE_PATHS = [
    '.github/workflows',
];

function shouldSkipPath(relPath) {
    const normalized = relPath.split(path.sep).join('/');
    return MIRROR_EXCLUDE_PATHS.some(p => normalized === p || normalized.startsWith(p + '/'));
}

function copyRespectingExclusions(src, dest, baseSrc) {
    const stat = fs.statSync(src);
    const rel = path.relative(baseSrc, src);
    if (rel && shouldSkipPath(rel)) return;
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRespectingExclusions(path.join(src, entry), path.join(dest, entry), baseSrc);
        }
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

function clearRespectingExclusions(dir, baseDir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const rel = path.relative(baseDir, full);
        if (MIRROR_EXCLUDE_TOP.has(entry) && full === path.join(baseDir, entry)) continue;
        if (shouldSkipPath(rel)) continue;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
            clearRespectingExclusions(full, baseDir);
            try { fs.rmdirSync(full); } catch {}
        } else {
            fs.unlinkSync(full);
        }
    }
}

function hasRsync() {
    try {
        execFileSync('rsync', ['--version'], { stdio: 'ignore' });
        return true;
    } catch { return false; }
}

function syncWorkspaceToMirror(workspaceDir, mirrorDir) {
    const wsSlash = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;

    if (hasRsync()) {
        const excludeArgs = [];
        for (const p of MIRROR_EXCLUDE_PATHS) excludeArgs.push('--exclude', `/${p}`);
        excludeArgs.push('--exclude', '/.git');

        const args = ['-a', '--delete', ...excludeArgs, wsSlash, mirrorDir + path.sep];
        console.log(`[mirror] rsync ${args.join(' ')}`);
        execFileSync('rsync', args, { stdio: 'inherit' });
        console.log(`[mirror] rsync complete (excluded: ${MIRROR_EXCLUDE_PATHS.join(', ')}, .git)`);
        return { filesCopied: 0, mode: 'rsync' };
    }

    clearRespectingExclusions(mirrorDir, mirrorDir);
    let copied = 0;
    for (const entry of fs.readdirSync(workspaceDir)) {
        if (MIRROR_EXCLUDE_TOP.has(entry)) continue;
        const src = path.join(workspaceDir, entry);
        const dest = path.join(mirrorDir, entry);
        copyRespectingExclusions(src, dest, workspaceDir);
        copied++;
    }
    console.log(`[mirror] cpSync complete (excluded: ${MIRROR_EXCLUDE_PATHS.join(', ')})`);
    return { filesCopied: copied, mode: 'cpSync' };
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
    console.log(`[mirror] Copied ${sync.filesCopied} top-level entries from workspace`);

    let mirrored = 0;
    let caughtUp = 0;
    const errors = [];
    const uploadedDirs = new Set(uploads.map(u => path.resolve(u.resourceDir)));

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

    const allMarked = findResourcesWithMarker(null, [workspace]);
    const catchupCandidates = allMarked.filter(d => !uploadedDirs.has(path.resolve(d)));
    if (catchupCandidates.length) {
        console.log(`[mirror] Catch-up scan: ${catchupCandidates.length} marked resource(s) not uploaded this run`);
    }

    for (const resourceDir of catchupCandidates) {
        const folderName = path.basename(resourceDir);
        const marker = readEscrowMarker(resourceDir);
        if (!marker || !marker.assetId) {
            console.log(`[mirror] ${folderName}: skip catch-up (no asset id in .escrow)`);
            continue;
        }

        const relPath = path.relative(workspace, resourceDir).split(path.sep).join('/');
        const mirrorResourceDir = path.join(cloneDir, relPath);
        const fxapMarkerPath = path.join(mirrorResourceDir, '.fxap');

        if (fs.existsSync(fxapMarkerPath)) {
            console.log(`[mirror] ${folderName}: mirror already has .fxap, skip`);
            continue;
        }

        if (!cfxPortal) {
            console.warn(`[mirror] ${folderName}: missing .fxap but no CFX session; cannot catch up`);
            errors.push({ resource: folderName, error: 'cfx portal not authenticated for catch-up' });
            continue;
        }

        try {
            console.log(`[mirror] ${folderName}: catching up — downloading FXAP for asset ${marker.assetId}`);
            const pack = await cfxPortal.downloadPack(marker.assetId);
            const { entryCount, strippedPrefix } = extractPackTo(pack.zipBuffer, mirrorResourceDir, folderName);
            console.log(`[mirror] ${folderName}: caught up at ${relPath} with ${entryCount} FXAP files${strippedPrefix ? ` (stripped "${strippedPrefix}")` : ''}`);
            caughtUp++;
            mirrored++;
        } catch (e) {
            console.error(`[mirror] catch-up FAIL ${folderName}: ${e.message}`);
            errors.push({ resource: folderName, error: e.message });
        }
    }

    if (caughtUp) {
        console.log(`[mirror] Caught up FXAP for ${caughtUp} resource(s) that hadn't been mirrored before`);
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

module.exports = { mirrorFxap, extractPackTo, syncWorkspaceToMirror, MIRROR_EXCLUDE_PATHS };
