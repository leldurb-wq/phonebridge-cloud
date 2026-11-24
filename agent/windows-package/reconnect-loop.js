'use strict';

async function runReconnectLoop({ credentials:initial, claim, reEnroll, onCommand, sleep, report, signal }) {
  let credentials=initial;
  let requiresEnrollment=false;
  while(!signal?.aborted) {
    if(requiresEnrollment) {
      try { credentials=await reEnroll(credentials); requiresEnrollment=false; }
      catch(enrollmentError) { report('enroll-error',enrollmentError); await sleep(5000); }
      continue;
    }
    try {
      const result=await claim(credentials);
      if(result?.command)await onCommand(result.command,credentials);
      await sleep(3000);
    } catch(error) {
      if(error.statusCode===401||error.statusCode===403) {
        report('reauth',error);
        requiresEnrollment=true;
      } else {
        report('network',error);
        await sleep(5000);
      }
    }
  }
  return credentials;
}

module.exports={runReconnectLoop};
