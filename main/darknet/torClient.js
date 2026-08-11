/**
 * HTTP client that can optionally route through a local Tor SOCKS5 proxy
 * (default socks5h://127.0.0.1:9050). Clearnet requests use a plain agent.
 */
'use strict';

const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const http = require('http');
const https = require('https');

const DEFAULT_TOR = process.env.TOR_PROXY || 'socks5h://127.0.0.1:9050';

function createTorClient(proxyUrl = DEFAULT_TOR) {
  const agent = new SocksProxyAgent(proxyUrl);
  return axios.create({
    httpAgent: agent,
    httpsAgent: agent,
    timeout: 45_000, // Tor is slow
    maxRedirects: 3,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': 'GlobeGram-OSINT/0.1 (CTI research; local)',
      Accept: 'application/rss+xml, application/xml, text/xml, text/html, */*',
    },
  });
}

function createClearnetClient() {
  return axios.create({
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: 25_000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': 'GlobeGram-OSINT/0.1 (CTI research; local)',
      Accept: 'application/rss+xml, application/xml, text/xml, text/html, */*',
    },
  });
}

/** Probe Tor SOCKS port — returns true if a Tor daemon is reachable. */
async function probeTor(proxyUrl = DEFAULT_TOR) {
  try {
    const client = createTorClient(proxyUrl);
    // check.torproject.org returns 200 through Tor; any response proves SOCKS works
    await client.get('http://check.torproject.org/', { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  createTorClient,
  createClearnetClient,
  probeTor,
  DEFAULT_TOR,
};
