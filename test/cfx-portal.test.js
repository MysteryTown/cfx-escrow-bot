const test = require('node:test');
const assert = require('node:assert/strict');
const CFXPortal = require('../src/cfx-portal');

test('getAssets retries transient network failures', async () => {
    const portal = new CFXPortal('cookie');
    portal.retryBaseDelay = 0;
    let calls = 0;
    portal.apiRequest = async () => {
        calls++;
        if (calls === 1) {
            const error = new Error('read ECONNRESET');
            error.code = 'ECONNRESET';
            throw error;
        }
        return { data: { items: [{ id: 1, name: 'resource' }] } };
    };

    const assets = await portal.getAssets();

    assert.equal(calls, 2);
    assert.deepEqual(assets, [{ id: 1, name: 'resource' }]);
});

test('getAssets retries server errors', async () => {
    const portal = new CFXPortal('cookie');
    portal.retryBaseDelay = 0;
    let calls = 0;
    portal.apiRequest = async () => {
        calls++;
        if (calls === 1) {
            const error = new Error('service unavailable');
            error.response = { status: 503 };
            throw error;
        }
        return { data: { items: [] } };
    };

    const assets = await portal.getAssets();

    assert.equal(calls, 2);
    assert.deepEqual(assets, []);
});

test('getAssets does not hide permanent errors', async () => {
    const portal = new CFXPortal('cookie');
    portal.retryBaseDelay = 0;
    const error = new Error('unauthorized');
    error.response = { status: 401 };
    portal.apiRequest = async () => {
        throw error;
    };

    await assert.rejects(portal.getAssets(), error);
});
