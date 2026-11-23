'use strict';
const crypto=require('node:crypto');

function generatePairingCode(){return String(crypto.randomInt(0,1000000)).padStart(6,'0');}
function hashEnrollmentCode(code,secret){
  return /^\d{6}$/.test(code)
    ? crypto.createHmac('sha256',secret).update('phonebridge-pairing-code:v1:').update(code).digest('hex')
    : crypto.createHash('sha256').update(code).digest('hex');
}
function hashLegacyPairingCode(code){return crypto.createHash('sha256').update(code).digest('hex');}

module.exports={generatePairingCode,hashEnrollmentCode,hashLegacyPairingCode};
