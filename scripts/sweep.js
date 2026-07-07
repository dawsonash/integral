// Runs one retention sweep and exits — for cron, or ad-hoc cleanup.
// Usage: node scripts/sweep.js
const { sweep } = require('../server/lib/retention');
console.log(JSON.stringify(sweep()));
