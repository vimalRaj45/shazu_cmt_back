require('dotenv').config();
const dns = require('dns');
const { Pool } = require('pg');

// Configure public DNS servers fallback (Google & Cloudflare) for robust cloud DB connection
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
  const originalLookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    originalLookup(hostname, options, (err, address, family) => {
      if (!err && address) {
        return callback(null, address, family);
      }
      // If local DNS fails (ENOTFOUND), resolve via public DNS servers
      dns.resolve4(hostname, (resErr, addresses) => {
        if (!resErr && addresses && addresses.length > 0) {
          if (options && options.all) {
            return callback(null, addresses.map((ip) => ({ address: ip, family: 4 })));
          }
          return callback(null, addresses[0], 4);
        }
        return callback(err || resErr);
      });
    });
  };
} catch (dnsErr) {
  // Graceful fallback if dns.setServers is unavailable in environment
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
