'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const CHUNK_SIZE=8*1024*1024;
const MAX_FILE_SIZE=2*1024*1024*1024;

function safeName(value){
  const name=String(value||'file').normalize('NFKC').replace(/[<>:"\/\\|?*\x00-\x1f]/g,'_').replace(/^\.+/,'').trim().slice(0,180);
  return name||'file';
}

async function receiveTransfer({transfer,downloadChunk,complete,baseDir}){
  if(!transfer||! /^[0-9a-f-]{36}$/i.test(transfer.id||''))throw new Error('Invalid transfer details.');
  const size=Number(transfer.sizeBytes),chunkSize=Number(transfer.chunkSize),chunkCount=Number(transfer.chunkCount);
  if(!Number.isSafeInteger(size)||size<1||size>MAX_FILE_SIZE||chunkSize!==CHUNK_SIZE||chunkCount!==Math.ceil(size/chunkSize)||!Array.isArray(transfer.chunks)||transfer.chunks.length!==chunkCount)throw new Error('Transfer metadata is invalid.');
  const root=path.resolve(baseDir);
  fs.mkdirSync(root,{recursive:true});
  const finalName=safeName(transfer.fileName);
  let target=path.join(root,finalName);
  if(path.dirname(target)!==root)throw new Error('Unsafe destination path.');
  if(fs.existsSync(target)){
    const ext=path.extname(finalName),stem=path.basename(finalName,ext);
    target=path.join(root,stem+' ('+transfer.id.slice(0,8)+')'+ext);
  }
  const temp=target+'.'+transfer.id+'.part';
  let fd;
  try{
    let written=0;
    if(fs.existsSync(temp)){
      const existing=fs.statSync(temp);
      if(!existing.isFile()||existing.size>size){fs.unlinkSync(temp);}
      else written=existing.size===size?size:Math.floor(existing.size/chunkSize)*chunkSize;
    }
    if(fs.existsSync(temp)){fd=fs.openSync(temp,'r+');fs.ftruncateSync(fd,written);}
    else fd=fs.openSync(temp,'wx',0o600);
    const firstChunk=written===size?chunkCount:Math.floor(written/chunkSize);
    for(let index=firstChunk;index<chunkCount;index++){
      const meta=transfer.chunks[index];
      if(meta.index!==index)throw new Error('Transfer is missing a chunk.');
      const expected=index===chunkCount-1?size-index*chunkSize:chunkSize;
      if(meta.sizeBytes!==expected)throw new Error('Transfer chunk size is invalid.');
      let bytes=null,lastError=null;
      for(let attempt=0;attempt<3;attempt++){
        try{bytes=await downloadChunk(transfer.id,index);lastError=null;break;}
        catch(error){lastError=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}
      }
      if(lastError)throw lastError;
      if(!Buffer.isBuffer(bytes)||bytes.length!==expected)throw new Error('A file chunk was incomplete.');
      const digest=crypto.createHash('sha256').update(bytes).digest('hex');
      if(digest!==meta.sha256)throw new Error('A file chunk failed its integrity check.');
      let offset=0;
      while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset,written+offset);
      written+=bytes.length;
    }
    if(written!==size)throw new Error('The received file size does not match the upload.');
    fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    fs.renameSync(temp,target);
    await complete({status:'completed'});
    return {path:target,size:written};
  }catch(error){
    if(fd!==undefined&&fd!==null)try{fs.closeSync(fd)}catch{}
    try{fs.unlinkSync(temp)}catch{}
    try{await complete({status:'failed',error:String(error.message||'Transfer failed').slice(0,240)})}catch{}
    throw error;
  }
}

module.exports={receiveTransfer,CHUNK_SIZE,MAX_FILE_SIZE,safeName};
