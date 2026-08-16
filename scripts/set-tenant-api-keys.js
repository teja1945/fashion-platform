#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const TENANTS = [
  { id: '8ae20661-626d-42c9-b930-6c926ca3ce99', name: 'Demo Tenant', envVar: 'BRG_DEMO_TENANT_API_KEY' },
  { id: 'f06b9548-fb4b-4684-90ef-1e249cdfc4be', name: 'Demo Tenant Kedua', envVar: 'BRG_DEMO2_TENANT_API_KEY' },
];

function generateApiKey() {
  return 'brg_' + crypto.randomBytes(32).toString('hex');
}

function mask(key) {
  return key.slice(0, 8) + '...' + key.slice(-4);
}

async function main() {
  const envPath = path.join(__dirname, '..', '.env');
  const results = [];

  for (const tenant of TENANTS) {
    const apiKey = generateApiKey();

    await pool.query('SELECT set_tenant_api_key($1, $2)', [tenant.id, apiKey]);

    console.log(`[OK] ${tenant.name} (${tenant.id}) -> ${tenant.envVar}=${mask(apiKey)}`);
    results.push({ envVar: tenant.envVar, apiKey });
  }

  const lines = results.map(r => `${r.envVar}=${r.apiKey}`).join('\n');
  fs.appendFileSync(envPath, `\n# Generated ${new Date().toISOString()} by set-tenant-api-keys.js\n${lines}\n`);

  console.log(`\nSelesai. ${results.length} API key ditulis ke ${envPath}.`);
  console.log('Verifikasi manual: cat .env | grep TENANT_API_KEY (jangan paste hasilnya ke chat).');

  await pool.end();
}

main().catch(err => {
  console.error('[GAGAL]', err.message);
  process.exit(1);
});
