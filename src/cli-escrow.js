#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const CFXPortal = require('./cfx-portal');
const { findResourcesWithMarker, escrowResource } = require('./escrow-resource');
const { mirrorFxap } = require('./mirror-fxap');

function parseArgs(argv) {
    const args = { resources: [], scanRoots: [], all: false, mirrorRepo: null, mirrorToken: null, mirrorBranch: 'main', workspace: process.cwd() };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--resource' || a === '-r') args.resources.push(argv[++i]);
        else if (a === '--scan' || a === '-s') args.scanRoots.push(argv[++i]);
        else if (a === '--all') args.all = true;
        else if (a === '--mirror-repo') args.mirrorRepo = argv[++i];
        else if (a === '--mirror-token') args.mirrorToken = argv[++i];
        else if (a === '--mirror-branch') args.mirrorBranch = argv[++i];
        else if (a === '--workspace') args.workspace = argv[++i];
        else if (a === '--help' || a === '-h') {
            console.log(`Usage:
  cli-escrow --resource <dir>         Upload a single resource folder (must contain .escrow)
  cli-escrow --scan <dir>             Scan dir for resources with .escrow markers
  cli-escrow --all                    Scan cwd recursively

Mirror options (download FXAP and commit to escrowed repo):
  --mirror-repo <owner/repo>          Target escrowed repo (e.g. MysteryTown/MT08-Escrowed)
  --mirror-token <pat>                PAT with push access on the mirror repo
  --mirror-branch <branch>            Default: main
  --workspace <dir>                   Source repo root; resource paths inside this become paths in the mirror

Env:
  CFX_FORUM_COOKIE   Required. Your forum.cfx.re _t cookie.

Exit codes:
  0  All resources uploaded (and mirror succeeded if enabled)
  1  Auth or fatal error
  2  One or more resources failed`);
            process.exit(0);
        }
        else args.resources.push(a);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);

    let targets = [...args.resources.map(r => path.resolve(r))];
    if (args.scanRoots.length || args.all) {
        const roots = args.scanRoots.length ? args.scanRoots : [process.cwd()];
        const found = findResourcesWithMarker(null, roots);
        targets.push(...found);
    }
    targets = [...new Set(targets)].filter(t => {
        if (!fs.existsSync(t)) {
            console.warn(`[escrow] Skipping missing path: ${t}`);
            return false;
        }
        if (!fs.existsSync(path.join(t, '.escrow'))) {
            console.warn(`[escrow] Skipping (no .escrow marker): ${t}`);
            return false;
        }
        return true;
    });

    const wantsMirror = !!args.mirrorRepo;
    if (!targets.length && !wantsMirror) {
        console.log('[escrow] Nothing to do (no resources, no mirror).');
        process.exit(0);
    }

    if (targets.length) {
        console.log(`[escrow] ${targets.length} resource(s) to upload:`);
        targets.forEach(t => console.log(`  - ${t}`));
    } else {
        console.log('[escrow] No resources to upload this run; will still sync mirror if configured.');
    }

    let portal = null;
    const needCfx = targets.length > 0 || wantsMirror;
    if (needCfx) {
        const cookie = process.env.CFX_FORUM_COOKIE;
        if (!cookie) {
            console.error('[escrow] CFX_FORUM_COOKIE env var is required (uploads or mirror catch-up need it)');
            process.exit(1);
        }
        portal = new CFXPortal(cookie);
        const authed = await portal.authenticate();
        if (!authed) {
            console.error('[escrow] CFX authentication failed. Check CFX_FORUM_COOKIE.');
            await portal.close();
            process.exit(1);
        }
        await portal.close();
    }

    const results = [];
    let hadFailure = false;
    for (const dir of targets) {
        try {
            const result = await escrowResource(portal, dir);
            console.log(`[escrow] OK ${result.resource} → asset ${result.assetId} (${result.action})`);
            results.push({ ok: true, resourceDir: dir, ...result });
        } catch (e) {
            console.error(`[escrow] FAIL ${dir}: ${e.message}`);
            hadFailure = true;
            results.push({ ok: false, resourceDir: dir, resource: path.basename(dir), error: e.message });
        }
    }

    if (wantsMirror && hadFailure) {
        console.error('[mirror] Skipped because one or more requested uploads failed; refusing to restore stale asset packs');
    } else if (wantsMirror) {
        const uploads = results.filter(r => r.ok);
        try {
            console.log(`[mirror] Syncing workspace + ${uploads.length} FXAP overlay(s) → ${args.mirrorRepo}:${args.mirrorBranch}`);
            const summary = await mirrorFxap(portal, uploads, {
                mirrorRepo: args.mirrorRepo,
                mirrorToken: args.mirrorToken,
                mirrorBranch: args.mirrorBranch,
                workspace: path.resolve(args.workspace),
            });
            console.log(`[mirror] Done. ${summary.mirrored ?? 0} mirrored, ${summary.skipped ?? 0} skipped${summary.errors?.length ? `, ${summary.errors.length} errors` : ''}${summary.noop ? ' (no changes)' : ''}`);
        } catch (e) {
            console.error(`[mirror] FAILED: ${e.message}`);
            hadFailure = true;
        }
    }

    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
        const lines = [
            '## CFX Escrow Upload',
            '',
            '| Resource | Asset ID | Action | Status |',
            '|---|---|---|---|',
            ...results.map(r => r.ok
                ? `| \`${r.resource}\` | ${r.assetId} | ${r.action} | ✅ |`
                : `| \`${r.resource}\` | – | – | ❌ ${r.error} |`),
        ];
        fs.appendFileSync(summary, lines.join('\n') + '\n');
    }

    const output = process.env.GITHUB_OUTPUT;
    if (output) {
        fs.appendFileSync(output, `uploaded=${results.filter(r => r.ok).length}\n`);
        fs.appendFileSync(output, `failed=${results.filter(r => !r.ok).length}\n`);
    }

    process.exit(hadFailure ? 2 : 0);
}

main().catch(e => {
    console.error('[escrow] Fatal:', e);
    process.exit(1);
});
