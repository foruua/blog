import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupPublicDns, assertPublicUrl } from '../src/feeds/fetch.js';

const resolver = (answers, status = 0) => async (url) => ({
  ok: true, json: async () => ({ Status: status,
    Answer: answers.filter((a) => a.type === Number(url.searchParams.get('type'))) }),
});

test('HTTPS DNS resolves both address families and ignores CNAME records', async () => {
  const fetcher = resolver([{ type: 5, data: 'alias.example' },
    { type: 1, data: '104.21.47.189' }, { type: 28, data: '2606:4700::1111' }]);
  assert.deepEqual(await lookupPublicDns('example.com', { fetcher }), [
    { address: '104.21.47.189', family: 4 }, { address: '2606:4700::1111', family: 6 },
  ]);
});

test('HTTPS DNS failures never silently fall back to unchecked addresses', async () => {
  await assert.rejects(lookupPublicDns('example.com', { fetcher: resolver([], 2) }));
  await assert.rejects(lookupPublicDns('example.com', {
    fetcher: resolver([{ type: 1, data: 'invalid' }]),
  }));
});

test('HTTPS DNS results still reject private, fake-IP and mixed public/private answers', async () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '198.18.0.19', '::1']) {
    const family = address.includes(':') ? 6 : 4;
    const fetcher = resolver([{ type: 1, data: '104.21.47.189' },
      { type: family === 4 ? 1 : 28, data: address }]);
    await assert.rejects(assertPublicUrl('https://example.com', {
      lookup: (host) => lookupPublicDns(host, { fetcher }),
    }), { code: 'private-host' });
  }
});
