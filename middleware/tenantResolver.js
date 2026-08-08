const { pool } = require("../db");

function extractSubdomain(host) {
  if (!host) return null;
  const hostname = host.split(":")[0]; // buang port kalau ada, misal localhost:3000
  const parts = hostname.split(".");
  if (parts.length < 3) return null; // root domain / IP / localhost tanpa subdomain
  const sub = parts[0];
  return sub === "www" ? null : sub;
}

async function tenantResolver(req, res, next) {
  try {
    const subdomain = extractSubdomain(req.hostname);
    if (!subdomain) {
      return res.status(400).json({ error: "Subdomain tenant tidak terdeteksi" });
    }

    const { rows } = await pool.query(
      "SELECT * FROM resolve_tenant_id($1)",
      [subdomain]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Tenant tidak ditemukan" });
    }
    if (!rows[0].is_active) {
      return res.status(403).json({ error: "Tenant tidak aktif" });
    }

    req.tenantId = rows[0].id;
    req.tenantSubdomain = subdomain;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = tenantResolver;
module.exports.extractSubdomain = extractSubdomain;
