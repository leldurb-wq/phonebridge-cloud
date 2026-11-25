'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const CHUNK_SIZE=8*1024*1024;
const MAX_FILE_SIZE=2*1024*1024*1024;

function safeName(value){
  let name=String(value||'file').normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')
    .replace(/[. ]+$/g,'').replace(/^\.+/,'').trim().slice(0,180);
  if(!name)name='file';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name))name='_'+name;
  return name;
}

function digestFileChunk(fd,index,expected){
  const buffer=Buffer.alloc(expected);
  let offset=0;
  while(offset<expected){
    const count=fs.readSync(fd,buffer,offset,expected-offset,index*CHUNK_SIZE+offset);
    if(!count)break;
    offset+=count;
  }
  return offset===expected?crypto.createHash('sha256').update(buffer).digest('hex'):null;
}

function chooseTarget(root,finalName,transferId){
  const ext=path.extname(finalName),stem=path.basename(finalName,ext);
  const plain=path.join(root,finalName);
  if(!fs.existsSync(plain))return plain;
  for(let n=1;n<=99;n++){
    const suffix=n===1?transferId.slice(0,8):transferId.slice(0,8)+'-'+n;
    const candidate=path.join(root,stem+' ('+suffix+')'+ext);
    if(!fs.existsSync(candidate))return candidate;
  }
  throw new Error('Too many files with this name already exist in the Incoming folder.');
}

async function receiveTransfer({transfer,downloadChunk,complete,baseDir}){
  if(!transfer||! /^[0-9a-f-]{36}$/i.test(transfer.id||''))throw new Error('Invalid transfer details.');
  const rejectMetadata=async message=>{
    try{await complete({status:'failed',error:message})}catch{}
    throw new Error(message);
  };
  const size=Number(transfer.sizeBytes),chunkSize=Number(transfer.chunkSize),chunkCount=Number(transfer.chunkCount);
  if(!Number.isSafeInteger(size)||size<1||size>MAX_FILE_SIZE||chunkSize!==CHUNK_SIZE||
    chunkCount!==Math.ceil(size/chunkSize)||!Array.isArray(transfer.chunks)||transfer.chunks.length!==chunkCount)
    return rejectMetadata('Transfer metadata is invalid.');
  for(let i=0;i<chunkCount;i++){
    const meta=transfer.chunks[i];
    const expected=i===chunkCount-1?size-i*chunkSize:chunkSize;
    if(meta?.index!==i||meta?.sizeBytes!==expected||! /^[a-f0-9]{64}$/i.test(meta?.sha256||''))
      return rejectMetadata('Transfer chunk metadata is invalid.');
  }

  const root=path.resolve(baseDir);
  fs.mkdirSync(root,{recursive:true});
  const finalName=safeName(transfer.fileName);
  const receipt=path.join(root,'.phonebridge-'+transfer.id+'.json');
  let target,hasReceipt=false;
  try{
    const saved=JSON.parse(fs.readFileSync(receipt,'utf8'));
    if(typeof saved.targetName==='string'&&saved.targetName===path.basename(saved.targetName)){
      target=path.join(root,saved.targetName);
      hasReceipt=true;
    }else try{fs.unlinkSync(receipt)}catch{}
  }catch{try{fs.unlinkSync(receipt)}catch{}}
  if(!target)target=chooseTarget(root,finalName,transfer.id);
  if(path.dirname(target)!==root)throw new Error('Unsafe destination path.');
  const temp=target+'.'+transfer.id+'.part';
  const receiptTemp=receipt+'.tmp';

  const saveReceipt=()=>{
    try{fs.unlinkSync(receiptTemp)}catch{}
    fs.writeFileSync(receiptTemp,JSON.stringify({targetName:path.basename(target),transferId:transfer.id}),{flag:'wx'});
    fs.renameSync(receiptTemp,receipt);
  };
  const reportComplete=async()=>{
    try{
      await complete({status:'completed'});
      try{fs.unlinkSync(receipt)}catch{}
      return {path:target,size};
    }catch(error){
      error.retryable=true;
      throw error;
    }
  };

  try{
    if(fs.existsSync(target)){
      const stat=fs.statSync(target);
      if(!stat.isFile()||stat.size!==size)throw new Error('A file already exists at the PhoneBridge destination and does not match this transfer.');
      const fd=fs.openSync(target,'r');
      try{
        for(let i=0;i<chunkCount;i++){
          const expected=i===chunkCount-1?size-i*chunkSize:chunkSize;
          if(digestFileChunk(fd,i,expected)!==transfer.chunks[i].sha256)
            throw new Error('The saved file failed its integrity check.');
        }
      }finally{fs.closeSync(fd)}
      return await reportComplete();
    }

    if(!hasReceipt)saveReceipt();
    let written=0,fd;
    try{
      if(fs.existsSync(temp)){
        const existing=fs.statSync(temp);
        if(!existing.isFile()||existing.size>size){fs.unlinkSync(temp);}
        else written=existing.size===size?size:Math.floor(existing.size/chunkSize)*chunkSize;
      }
      if(fs.existsSync(temp)){
        fd=fs.openSync(temp,'r+');
        for(let i=0;i<Math.ceil(written/chunkSize);i++){
          const expected=Math.min(CHUNK_SIZE,written-i*CHUNK_SIZE);
          if(digestFileChunk(fd,i,expected)!==transfer.chunks[i].sha256){written=i*CHUNK_SIZE;break;}
        }
        fs.ftruncateSync(fd,written);
      }else fd=fs.openSync(temp,'wx',0o600);

      const firstChunk=written===size?chunkCount:Math.floor(written/chunkSize);
      for(let index=firstChunk;index<chunkCount;index++){
        const meta=transfer.chunks[index];
        const expected=index===chunkCount-1?size-index*chunkSize:chunkSize;
        let bytes=null,lastError=null;
        for(let attempt=0;attempt<3;attempt++){
          try{bytes=await downloadChunk(transfer.id,index);lastError=null;break}
          catch(error){lastError=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)))}
        }
        if(lastError){
          if([400,404,409,413,422].includes(lastError.statusCode))throw lastError;
          lastError.retryable=true;
          throw lastError;
        }
        if(!Buffer.isBuffer(bytes)||bytes.length!==expected)throw new Error('A file chunk was incomplete.');
        const actual=crypto.createHash('sha256').update(bytes).digest('hex');
        if(actual!==meta.sha256)throw new Error('A file chunk failed its integrity check.');
        let offset=0;
        while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset,written+offset);
        written+=bytes.length;
        fs.fsyncSync(fd);
      }
      if(written!==size)throw new Error('The received file size does not match the upload.');
      fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    }catch(error){
      if(fd!==undefined&&fd!==null)try{fs.closeSync(fd)}catch{}
      if(error.retryable){
        try{await complete({status:'queued',error:'Temporary connection problem. The ThinkPad will resume this transfer.'})}
        catch(updateError){updateError.retryable=true;throw updateError}
        return {retrying:true,size:written};
      }
      try{fs.unlinkSync(temp)}catch{}
      try{fs.unlinkSync(receipt)}catch{}
      try{await complete({status:'failed',error:String(error.message||'Transfer failed').slice(0,240)})}catch{}
      throw error;
    }

    try{fs.renameSync(temp,target)}
    catch(error){
      error.retryable=true;
      try{await complete({status:'queued',error:'The file is ready but Windows could not finalize it yet. PhoneBridge will retry.'})}catch{}
      return {retrying:true,size:written};
    }
    return await reportComplete();
  }catch(error){
    if(!error.retryable){
      try{fs.unlinkSync(temp)}catch{}
      try{fs.unlinkSync(receipt)}catch{}
      try{await complete({status:'failed',error:String(error.message||'Transfer failed').slice(0,240)})}catch{}
    }
    throw error;
  }
}

module.exports={receiveTransfer,CHUNK_SIZE,MAX_FILE_SIZE,safeName};
