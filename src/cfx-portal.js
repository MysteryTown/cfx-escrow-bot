const axios = require('axios');
const FormData = require('form-data');
const puppeteer = require('puppeteer');

const URLS = {
    API: 'https://portal-api.cfx.re/v1/',
    SSO: 'auth/discourse?return=',
    REUPLOAD: 'assets/{id}/re-upload',
    UPLOAD_CHUNK: 'assets/{id}/versions/{vid}/upload-chunk',
    COMPLETE_UPLOAD: 'assets/{id}/versions/{vid}/complete-upload',
    DOWNLOAD: 'assets/{id}/versions/{vid}/packs/{pid}/download',
    SEARCH_ASSETS: 'me/assets',
};

function isMostlyPrintable(s) {
    if (!s) return true;
    const sample = s.slice(0, 200);
    let printable = 0;
    for (let i = 0; i < sample.length; i++) {
        const c = sample.charCodeAt(i);
        if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) printable++;
    }
    return printable / sample.length > 0.9;
}

class CFXPortal {
    constructor(forumCookie) {
        this.forumCookie = forumCookie;
        this.cookies = null;
        this.browser = null;
        this.authenticated = false;
    }

    getUrl(type, params = null) {
        let url = URLS.API + URLS[type];
        if (params == null) return url;
        if (typeof params === 'string' || typeof params === 'number') {
            return url.replace('{id}', String(params));
        }
        for (const [k, v] of Object.entries(params)) {
            url = url.replace(`{${k}}`, String(v));
        }
        return url;
    }

    /**
     * Authenticate with the CFX Portal using Puppeteer
     * This mimics Tynopia's approach exactly
     */
    async authenticate(maxRetries = 3) {
        console.log('[CFX] Launching browser for authentication...');

        this.browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await this.browser.newPage();

        try {
            // Step 1: Navigate to SSO URL and get redirect URL
            const redirectUrl = await this.getRedirectUrl(page, maxRetries);

            // Step 2: Set the forum cookie
            await this.setForumCookie(page);

            // Step 3: Follow the redirect - this completes the auth
            console.log('[CFX] Following SSO redirect...');
            await page.goto(redirectUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            // Step 4: Check if we landed on portal
            if (page.url().includes('portal.cfx.re')) {
                console.log('[CFX] Authentication successful!');
                
                // Extract all cookies from browser
                this.cookies = await this.getCookiesString(page);
                this.authenticated = true;
                return true;
            } else {
                console.log('[CFX] Redirect failed. Current URL:', page.url());
                throw new Error('Redirect failed. Make sure the provided Cookie is valid.');
            }

        } catch (error) {
            console.error('[CFX] Authentication failed:', error.message);
            return false;
        }
    }

    /**
     * Navigate to SSO URL and get the redirect URL
     */
    async getRedirectUrl(page, maxRetries) {
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                console.log('[CFX] Navigating to SSO URL (attempt ' + (attempt + 1) + ')...');

                await page.goto(this.getUrl('SSO'), {
                    waitUntil: 'networkidle0',
                    timeout: 30000
                });

                // Parse the JSON response
                const responseBody = await page.evaluate(() => {
                    try {
                        return JSON.parse(document.body.innerText);
                    } catch {
                        return null;
                    }
                });

                if (!responseBody || !responseBody.url) {
                    throw new Error('Invalid SSO response');
                }

                const redirectUrl = responseBody.url;
                console.log('[CFX] Got redirect URL');

                // Navigate to forum origin first
                const forumUrl = new URL(redirectUrl).origin;
                await page.goto(forumUrl);

                return redirectUrl;

            } catch (error) {
                console.log(`[CFX] SSO attempt ${attempt + 1} failed: ${error.message}`);
                attempt++;
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }

        throw new Error(`Failed to navigate to SSO URL after ${maxRetries} attempts.`);
    }

    /**
     * Set the forum cookie in the browser
     */
    async setForumCookie(page) {
        console.log('[CFX] Setting forum cookie...');

        await page.setCookie({
            name: '_t',
            value: this.forumCookie,
            domain: 'forum.cfx.re',
            path: '/',
            httpOnly: true,
            secure: true,
        });

        console.log('[CFX] Cookie set');
    }

    /**
     * Get cookies from browser as a string (from all domains)
     */
    async getCookiesString(page) {
        // Get cookies from all relevant domains
        const client = await page.target().createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    /**
     * Close the browser
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    async apiRequest(method, url, data = null, headers = {}) {
        if (!this.cookies) {
            throw new Error('Not authenticated. Call authenticate() first.');
        }

        const config = {
            method,
            url,
            headers: {
                'Cookie': this.cookies,
                ...headers
            },
            validateStatus: (s) => s >= 200 && s < 300,
        };

        if (data) {
            config.data = data;
            if (data instanceof FormData) {
                config.headers = { ...config.headers, ...data.getHeaders() };
            }
        }

        try {
            return await axios(config);
        } catch (error) {
            if (error.response) {
                const body = error.response.data;
                const status = error.response.status;
                const shortUrl = url.replace(/^https?:\/\/[^/]+/, '');
                let bodyStr = '';
                if (body == null) {
                    bodyStr = '<empty>';
                } else if (Buffer.isBuffer(body)) {
                    bodyStr = `<binary, ${body.length} bytes>`;
                } else if (typeof body === 'string') {
                    bodyStr = isMostlyPrintable(body) ? body.slice(0, 500) : `<binary-ish string, ${body.length} chars>`;
                } else if (typeof body === 'object') {
                    try { bodyStr = JSON.stringify(body).slice(0, 800); } catch { bodyStr = '<unserializable>'; }
                } else {
                    bodyStr = String(body).slice(0, 200);
                }
                console.error(`[CFX] ${method} ${shortUrl} → ${status}: ${bodyStr}`);
            } else if (error.code) {
                console.error(`[CFX] ${method} ${url}: network error ${error.code}`);
            }
            throw error;
        }
    }

    /**
     * Get list of user's assets (all pages)
     */
    async getAssets(search = '') {
        try {
            let allAssets = [];
            let page = 1;
            let hasMore = true;

            while (hasMore) {
                const url = `${this.getUrl('SEARCH_ASSETS')}?page=${page}&search=${encodeURIComponent(search)}&sort=asset.name&direction=asc`;
                const response = await this.apiRequest('GET', url);
                
                const items = response.data.items || [];
                allAssets = allAssets.concat(items);

                // Check if there are more pages
                // If we got less than expected per page (usually 25), we're done
                if (items.length < 25) {
                    hasMore = false;
                } else {
                    page++;
                }

                // Safety limit to prevent infinite loops
                if (page > 50) {
                    console.log('[CFX] Reached page limit (50), stopping pagination');
                    hasMore = false;
                }
            }

            console.log(`[CFX] Fetched ${allAssets.length} assets across ${page} page(s)`);
            return allAssets;
        } catch (error) {
            console.error('[CFX] Failed to get assets:', error.message);
            return [];
        }
    }

    /**
     * Find asset by name (exact match)
     */
    async findAssetByName(name) {
        const assets = await this.getAssets(name);
        return assets.find(a => a.name === name) || null;
    }

    /**
     * Find asset by ID
     */
    async findAssetById(id) {
        const assets = await this.getAssets();
        return assets.find(a => a.id === parseInt(id)) || null;
    }

    async createAsset(name, zipBuffer, filename, chunkSize = 8388608) {
        if (!this.cookies) {
            throw new Error('Not authenticated. Call authenticate() first.');
        }

        const totalSize = zipBuffer.length;
        const chunkCount = Math.ceil(totalSize / chunkSize);

        console.log(`[CFX] Creating new asset: ${name}`);
        console.log(`[CFX] File: ${filename} (${totalSize} bytes, ${chunkCount} chunks)`);

        const payload = {
            name,
            chunk_count: chunkCount,
            chunk_size: chunkSize,
            total_size: totalSize,
            original_file_name: filename,
            release_candidate: false,
            version: '1.0.0'
        };

        const response = await this.apiRequest(
            'POST',
            `${URLS.API}me/assets`,
            payload,
            { 'Content-Type': 'application/json' }
        );

        const data = response.data;
        const assetId = data.asset_id || data.id;
        const versionId = data.version_id || data.version?.id || data.versions?.[0]?.id;
        if (!assetId || !versionId) {
            throw new Error(`Failed to create asset - missing ${!assetId ? 'asset_id' : 'version_id'} in response`);
        }

        console.log(`[CFX] Asset created: id=${assetId}, version=${versionId}`);
        return { id: assetId, versionId, chunkSize, chunkCount };
    }

    async uploadChunksAndComplete(assetId, versionId, zipBuffer, chunkSize, chunkCount) {
        for (let i = 0; i < chunkCount; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, zipBuffer.length);
            const chunk = zipBuffer.slice(start, end);
            await this.uploadChunk(assetId, versionId, i, chunk);
            console.log(`[CFX] Uploaded chunk ${i + 1}/${chunkCount}`);
        }
        await this.completeUpload(assetId, versionId);
    }

    async createAndUploadAsset(name, zipBuffer, filename, chunkSize = 8388608) {
        const { id, versionId, chunkSize: cs, chunkCount } = await this.createAsset(name, zipBuffer, filename, chunkSize);
        await this.uploadChunksAndComplete(id, versionId, zipBuffer, cs, chunkCount);
        return { id, name };
    }

    async startReupload(assetId, zipBuffer, filename, chunkSize = 2097152, maxAttempts = 6) {
        const totalSize = zipBuffer.length;
        const chunkCount = Math.ceil(totalSize / chunkSize);
        const delaysSec = [10, 20, 40, 60, 120];

        let response = null;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const version = `1.0.${Math.floor(Date.now() / 1000)}`;
            if (attempt === 0) {
                console.log(`[CFX] Starting re-upload: ${filename} (${totalSize} bytes, ${chunkCount} chunks) as v${version}`);
            } else {
                console.log(`[CFX] Retrying re-upload start as v${version} (attempt ${attempt + 1}/${maxAttempts})`);
            }

            try {
                response = await this.apiRequest(
                    'POST',
                    this.getUrl('REUPLOAD', assetId.toString()),
                    {
                        chunk_count: chunkCount,
                        chunk_size: chunkSize,
                        name: filename,
                        original_file_name: filename,
                        total_size: totalSize,
                        version,
                        changelog: 'Automated re-upload',
                        release_candidate: false
                    }
                );
                break;
            } catch (e) {
                const status = e.response?.status;
                const errMsg = (e.response?.data && (e.response.data.error || JSON.stringify(e.response.data))) || '';
                const isPendingAsset = status === 500 && /failed to get asset/i.test(errMsg);
                if (!isPendingAsset || attempt === maxAttempts - 1) throw e;
                const wait = delaysSec[attempt] || 120;
                console.log(`[CFX] Asset ${assetId} not ready for re-upload (CFX pack generation pending), waiting ${wait}s before retry`);
                await new Promise(r => setTimeout(r, wait * 1000));
            }
        }

        if (response.data.errors) {
            throw new Error('Failed to start re-upload: ' + JSON.stringify(response.data.errors));
        }

        const data = response.data;
        const versionId = data.version_id || data.version?.id || data.versions?.[0]?.id;
        if (!versionId) {
            console.error('[CFX] Re-upload response:', JSON.stringify(data));
            throw new Error('Failed to start re-upload - no version_id in response');
        }

        console.log(`[CFX] Re-upload version: ${versionId}`);
        return { chunkCount, chunkSize, versionId };
    }

    async uploadChunk(assetId, versionId, chunkIndex, chunkData, maxRetries = 4) {
        const url = this.getUrl('UPLOAD_CHUNK', { id: assetId, vid: versionId });
        let lastError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const form = new FormData();
            form.append('chunk_id', chunkIndex);
            form.append('chunk', chunkData, {
                filename: 'blob',
                contentType: 'application/octet-stream'
            });
            try {
                await this.apiRequest('POST', url, form);
                return;
            } catch (error) {
                lastError = error;
                const status = error.response?.status;
                const retryable = !status || (status >= 500 && status < 600) || status === 429;
                if (!retryable || attempt === maxRetries) throw error;
                const delay = 1500 * Math.pow(2, attempt);
                console.warn(`[CFX] chunk ${chunkIndex} → ${status || error.code}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastError;
    }

    async completeUpload(assetId, versionId, maxRetries = 3) {
        const url = this.getUrl('COMPLETE_UPLOAD', { id: assetId, vid: versionId });
        let lastError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                await this.apiRequest('POST', url, {});
                console.log('[CFX] Upload completed!');
                return;
            } catch (error) {
                lastError = error;
                const status = error.response?.status;
                const retryable = !status || (status >= 500 && status < 600) || status === 429;
                if (!retryable || attempt === maxRetries) throw error;
                const delay = 1500 * Math.pow(2, attempt);
                console.warn(`[CFX] complete → ${status || error.code}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastError;
    }

    async uploadAsset(assetId, zipBuffer, filename = 'resource.zip', chunkSize = 2097152) {
        const { chunkCount, versionId } = await this.startReupload(assetId, zipBuffer, filename, chunkSize);
        await this.uploadChunksAndComplete(assetId, versionId, zipBuffer, chunkSize, chunkCount);
        return { success: true, versionId };
    }

    async findAssetWithVersions(assetId) {
        const assets = await this.getAssets();
        const asset = assets.find(a => a.id === parseInt(assetId, 10));
        if (!asset) return null;
        if (!asset.versions?.length) return { ...asset, latestVersion: null, latestPack: null };
        const versions = [...asset.versions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const latestVersion = versions[0];
        const latestPack = latestVersion.packs?.[0] || null;
        return { ...asset, latestVersion, latestPack };
    }

    async getPackDownloadUrl(assetId, versionId, packId) {
        const url = this.getUrl('DOWNLOAD', { id: assetId, vid: versionId, pid: packId });
        const response = await this.apiRequest('GET', url);
        if (!response.data?.url) {
            throw new Error(`Download endpoint returned no url: ${JSON.stringify(response.data).slice(0, 200)}`);
        }
        return response.data.url;
    }

    async downloadPack(assetId, maxAttempts = 6) {
        const delaysSec = [5, 15, 30, 60, 120];
        let asset = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            asset = await this.findAssetWithVersions(assetId);
            if (!asset) throw new Error(`Asset ${assetId} not found in /me/assets`);
            if (!asset.latestVersion) throw new Error(`Asset ${assetId} has no versions yet`);

            if (asset.latestPack) break;

            if (attempt === maxAttempts - 1) {
                throw new Error(`Asset ${assetId} version ${asset.latestVersion.id} still has no packs after ${maxAttempts} attempts (CFX pack generation may be slow; will retry on next run via catch-up)`);
            }
            const wait = delaysSec[attempt] || 120;
            console.log(`[CFX] Asset ${assetId} (${asset.name}): pack not generated yet, waiting ${wait}s (attempt ${attempt + 1}/${maxAttempts})`);
            await new Promise(r => setTimeout(r, wait * 1000));
        }

        console.log(`[CFX] Downloading asset ${assetId} (${asset.name}) version ${asset.latestVersion.id} pack ${asset.latestPack.id}`);
        const signedUrl = await this.getPackDownloadUrl(assetId, asset.latestVersion.id, asset.latestPack.id);
        const response = await axios.get(signedUrl, { responseType: 'arraybuffer', maxContentLength: Infinity, maxBodyLength: Infinity });
        const buffer = Buffer.from(response.data);
        console.log(`[CFX] Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB for ${asset.name}`);
        return {
            assetId: asset.id,
            name: asset.name,
            versionId: asset.latestVersion.id,
            packId: asset.latestPack.id,
            zipBuffer: buffer,
        };
    }

    async getPortalSession() {
        if (!this.authenticated) return null;
        
        try {
            // Just verify we can access assets
            const assets = await this.getAssets();
            return { authenticated: true, assetCount: assets.length };
        } catch (error) {
            return null;
        }
    }
}

module.exports = CFXPortal;
