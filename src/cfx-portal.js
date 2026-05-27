const axios = require('axios');
const FormData = require('form-data');
const puppeteer = require('puppeteer');

const URLS = {
    API: 'https://portal-api.cfx.re/v1/',
    SSO: 'auth/discourse?return=',
    REUPLOAD: 'assets/{id}/re-upload',
    UPLOAD_CHUNK: 'assets/{id}/upload-chunk',
    COMPLETE_UPLOAD: 'assets/{id}/complete-upload',
    SEARCH_ASSETS: 'me/assets',
};

class CFXPortal {
    constructor(forumCookie) {
        this.forumCookie = forumCookie;
        this.cookies = null;
        this.browser = null;
        this.authenticated = false;
    }

    /**
     * Get full API URL
     */
    getUrl(type, id = null) {
        const url = URLS.API + URLS[type];
        return id ? url.replace('{id}', id) : url;
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
                waitUntil: 'networkidle0',
                timeout: 30000
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

    /**
     * Make an authenticated API request
     */
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
            }
        };

        if (data) {
            config.data = data;
            if (data instanceof FormData) {
                config.headers = { ...config.headers, ...data.getHeaders() };
            }
        }

        return axios(config);
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

    /**
     * Create a new asset AND upload the file in one flow
     * This is how the portal does it - create + upload combined
     */
    async createAndUploadAsset(name, zipBuffer, filename, chunkSize = 8388608) {
        if (!this.cookies) {
            throw new Error('Not authenticated. Call authenticate() first.');
        }

        const totalSize = zipBuffer.length;
        const chunkCount = Math.ceil(totalSize / chunkSize);

        console.log(`[CFX] Creating new asset: ${name}`);
        console.log(`[CFX] File: ${filename} (${totalSize} bytes, ${chunkCount} chunks)`);

        // Step 1: Create asset and initiate upload
        const createResponse = await axios({
            method: 'POST',
            url: `${URLS.API}me/assets`,
            data: {
                name: name,
                chunk_count: chunkCount,
                chunk_size: chunkSize,
                total_size: totalSize,
                original_file_name: filename
            },
            headers: {
                'Cookie': this.cookies,
                'Content-Type': 'application/json',
            },
        });

        const assetId = createResponse.data.asset_id || createResponse.data.id;
        
        if (!assetId) {
            console.error('[CFX] Create response:', createResponse.data);
            throw new Error('Failed to create asset - no asset ID returned');
        }

        console.log(`[CFX] Asset created with ID: ${assetId}`);

        // Step 2: Upload chunks
        for (let i = 0; i < chunkCount; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, zipBuffer.length);
            const chunk = zipBuffer.slice(start, end);

            await this.uploadChunk(assetId, i, chunk);
            console.log(`[CFX] Uploaded chunk ${i + 1}/${chunkCount}`);
        }

        // Step 3: Complete upload
        await this.completeUpload(assetId);

        return { id: assetId, name: name };
    }

    /**
     * Start the re-upload process
     */
    async startReupload(assetId, zipBuffer, filename, chunkSize = 2097152) {
        const totalSize = zipBuffer.length;
        const chunkCount = Math.ceil(totalSize / chunkSize);

        console.log(`[CFX] Starting upload: ${filename} (${totalSize} bytes, ${chunkCount} chunks)`);

        const response = await this.apiRequest(
            'POST',
            this.getUrl('REUPLOAD', assetId.toString()),
            {
                chunk_count: chunkCount,
                chunk_size: chunkSize,
                name: filename,
                original_file_name: filename,
                total_size: totalSize
            }
        );

        if (response.data.errors !== null) {
            throw new Error('Failed to start re-upload: ' + JSON.stringify(response.data.errors));
        }

        return { chunkCount, chunkSize };
    }

    /**
     * Upload a single chunk
     */
    async uploadChunk(assetId, chunkIndex, chunkData) {
        const form = new FormData();
        form.append('chunk_id', chunkIndex);
        form.append('chunk', chunkData, {
            filename: 'blob',
            contentType: 'application/octet-stream'
        });

        await this.apiRequest(
            'POST',
            this.getUrl('UPLOAD_CHUNK', assetId.toString()),
            form
        );
    }

    /**
     * Complete the upload
     */
    async completeUpload(assetId) {
        await this.apiRequest(
            'POST',
            this.getUrl('COMPLETE_UPLOAD', assetId.toString()),
            {}
        );
        console.log('[CFX] Upload completed!');
    }

    /**
     * Upload a zip file to an asset (full process)
     */
    async uploadAsset(assetId, zipBuffer, filename = 'resource.zip', chunkSize = 2097152) {
        // Start the upload
        const { chunkCount } = await this.startReupload(assetId, zipBuffer, filename, chunkSize);

        // Upload chunks
        for (let i = 0; i < chunkCount; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, zipBuffer.length);
            const chunk = zipBuffer.slice(start, end);

            await this.uploadChunk(assetId, i, chunk);
            console.log(`[CFX] Uploaded chunk ${i + 1}/${chunkCount}`);
        }

        // Complete upload
        await this.completeUpload(assetId);

        return { success: true };
    }

    /**
     * Get portal session/user info
     */
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