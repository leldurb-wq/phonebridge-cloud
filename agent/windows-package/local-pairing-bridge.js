'use strict';

const http=require('node:http');

function createLocalPairingBridge({createTicket,checkStatus,onApproved,origin='https://phonebridge-cloud.onrender.com',port=32145,host='127.0.0.1'}){
  let current=null,closed=false,polling=false;
  const json=(res,status,value)=>{const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':Buffer.byteLength(body)});res.end(body);};
  const server=http.createServer(async(req,res)=>{
    const requestOrigin=req.headers.origin||'';
    if(requestOrigin!==origin){res.writeHead(403,{'cache-control':'no-store'});return res.end();}
    res.setHeader('access-control-allow-origin',origin);
    res.setHeader('vary','Origin');
    res.setHeader('access-control-allow-methods','GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers','Content-Type');
    res.setHeader('access-control-allow-private-network','true');
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    if(req.url==='/health'&&req.method==='GET')return json(res,200,{ok:true});
    if(req.url==='/pairing/status'&&req.method==='GET')return json(res,200,{ok:true,status:current?.status||'idle',expiresAt:current?.expiresAt||null});
    if(req.url!=='/pairing/start'||req.method!=='POST')return json(res,404,{ok:false,error:'Not found.'});
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)return json(res,413,{ok:false,error:'Request too large.'});}
    let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{ok:false,error:'Invalid request.'});}
    const accessToken=typeof body.accessToken==='string'?body.accessToken:'';
    if(accessToken.length<20||accessToken.length>4096)return json(res,400,{ok:false,error:'Sign in to PhoneBridge and try again.'});
    if(polling||current&&['waiting','connecting'].includes(current.status)&&Date.parse(current.expiresAt)>Date.now())return json(res,409,{ok:false,error:'A pairing request is already active on this computer.'});
    try{
      const ticket=await createTicket(accessToken);
      if(!ticket?.ok||!/^\d{6}$/.test(ticket.pairingCode||'')||!Number.isFinite(Date.parse(ticket.expiresAt||'')))throw new Error('Cloud returned an invalid pairing ticket.');
      current={code:ticket.pairingCode,expiresAt:ticket.expiresAt,status:'waiting'};
      poll().catch(()=>{});
      return json(res,201,{ok:true,pairingCode:current.code,expiresAt:current.expiresAt});
    }catch(error){return json(res,502,{ok:false,error:error.message||'Could not create a pairing code.'});}
  });
  async function poll(){
    if(polling||closed)return;polling=true;
    try{
      while(!closed&&current?.status==='waiting'){
        if(Date.parse(current.expiresAt)<=Date.now()){current.status='expired';break;}
        try{
          const result=await checkStatus(current.code);
          if(result?.status==='approved'){
            current.status='connecting';
            try{await onApproved(current.code);current.status='connected';}
            catch(error){current.status='error';current.error=error.message||'Pairing could not complete.';}
            break;
          }
          if(result?.status==='expired'){current.status='expired';break;}
        }catch(_){}
        await new Promise(resolve=>setTimeout(resolve,2500));
      }
    }finally{polling=false;}
  }
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,host,()=>resolve({server,getStatus:()=>current?{status:current.status,expiresAt:current.expiresAt,error:current.error||null}:{status:'idle',expiresAt:null,error:null},close(){closed=true;server.close();}}));
  });
}

module.exports={createLocalPairingBridge};
