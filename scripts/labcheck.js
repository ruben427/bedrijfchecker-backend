#!/usr/bin/env node
// Draait de labmeting en print een tabel.
//
//   node scripts/labcheck.js          tabel
//   node scripts/labcheck.js --json   ruwe JSON
//
// LET OP: lokaal draaien meet jouw thuis- of kantoor-IP, niet dat van de
// server. De uitkomst die ertoe doet komt van Railway. Het verschil tussen
// die twee is zelf de meting: werkt het lokaal wel en op Railway niet, dan
// blokkeert het lab op IP.

const { probeAll } = require('../src/labProbe');

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

probeAll()
  .then((r) => {
    if (process.argv.indexOf('--json') !== -1) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.log('');
    console.log('Labmeting  ' + r.gemetenOp + '   omgeving: ' + r.omgeving);
    console.log('');
    console.log(pad('LAB', 22) + pad('SOORT', 14) + pad('STATUS', 8) + pad('KLASSE', 15) + pad('CF', 4) + pad('MS', 7) + 'BIJZONDERHEID');
    console.log('-'.repeat(110));
    r.resultaten.forEach((x) => {
      let bijz = '';
      if (x.fout) bijz = x.fout;
      else if (x.doorgestuurd) bijz = 'naar ' + x.eindUrl;
      else if (x.server) bijz = 'server: ' + x.server;
      console.log(
        pad(x.lab, 22) +
        pad(x.soort, 14) +
        pad(x.status == null ? '-' : x.status, 8) +
        pad(x.klasse, 15) +
        pad(x.cloudflare ? 'ja' : '', 4) +
        pad(x.duurMs, 7) +
        bijz
      );
    });
    console.log('');
    console.log(r.open + ' van ' + r.aantal + ' open, ' + r.geblokkeerd + ' geblokkeerd.');
    console.log('');
  })
  .catch((e) => {
    console.error('meting mislukt:', (e && e.message) || e);
    process.exit(1);
  });
