'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {receiveTransfer,CHUNK_SIZE,MAX_FILE_SIZE,safeName}=require('../agent/file-transfer');

function makeTransfer(bytes,name='movie.bin',id='6a2f1c1a-6b8e-4b9d-8a32-91ac6d90d777'){
  const chunks=[];
  for(let offset=0,index=0;offset<bytes.length;offset+=CHUNK_SIZE,index++){
    const part=bytes.subarray(offset,Math.min(bytes.length,offset+CHUNK_SIZE));
    chunks.push({index,sizeBytes:part.length,sha256:crypto.createHash('sha256').update(part).digest('hex')});
  }
  return {id,fileName:name,sizeBytes:bytes.length,chunkSize:CHUNK_SIZE,chunkCount:chunks.length,chunks};
}

test('PhoneBridge transfer names cannot escape the designated incoming folder or use reserved Windows names',()=>{
  assert.equal(safeName('../../secret.txt'),'_.._secret.txt');
  assert.equal(safeName('C:\\Users\\Other\\file?.txt'),'C__Users_Other_file_.txt');
  assert.equal(safeName('...'),'file');
  assert.equal(safeName('CON'),'_CON');
  assert.equal(safeName('trailing. '),'trailing');
});

test('large-file receiver writes verified chunks atomically and reports completion',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-'));
  const bytes=Buffer.from('PhoneBridge chunk test'),transfer=makeTransfer(bytes);
  let result,attempts=0;
  try{
    const saved=await receiveTransfer({transfer,baseDir:dir,downloadChunk:async()=>{attempts++;if(attempts===1)throw Error('temporary network interruption');return bytes},complete:async value=>{result=value}});
    assert.equal(fs.readFileSync(saved.path).toString(),bytes.toString());
    assert.equal(saved.size,bytes.length);
    assert.equal(attempts,2);
    assert.deepEqual(result,{status:'completed'});
    assert.deepEqual(fs.readdirSync(dir),['movie.bin']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('receiver resumes from the last complete verified chunk after a worker restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-resume-'));
  const first=Buffer.alloc(CHUNK_SIZE,0x61),last=Buffer.from('tail'),all=Buffer.concat([first,last]);
  const transfer=makeTransfer(all,'resume.bin');
  const partial=path.join(dir,'resume.bin.'+transfer.id+'.part');
  fs.writeFileSync(partial,first);
  const requested=[];
  try{
    const saved=await receiveTransfer({transfer,baseDir:dir,downloadChunk:async(_id,index)=>{requested.push(index);return last},complete:async()=>{}});
    assert.deepEqual(requested,[1]);
    assert.deepEqual(fs.readFileSync(saved.path),all);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('temporary cloud interruptions preserve verified chunks and requeue instead of failing the transfer',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-retry-'));
  const first=Buffer.alloc(CHUNK_SIZE,0x31),last=Buffer.from('last chunk'),all=Buffer.concat([first,last]);
  const transfer=makeTransfer(all,'retry.mov');
  const firstRun=[],secondRun=[],results=[];
  try{
    const interrupted=await receiveTransfer({transfer,baseDir:dir,downloadChunk:async(_id,index)=>{firstRun.push(index);if(index===1)throw Object.assign(new Error('network unavailable'),{code:'ECONNRESET'});return first},complete:async value=>{results.push(value)}});
    assert.equal(interrupted.retrying,true);
    assert.deepEqual(firstRun,[0,1,1,1]);
    assert.deepEqual(results,[{status:'queued',error:'Temporary connection problem. The ThinkPad will resume this transfer.'}]);
    const partial=path.join(dir,'retry.mov.'+transfer.id+'.part');
    assert.equal(fs.statSync(partial).size,CHUNK_SIZE);
    const saved=await receiveTransfer({transfer,baseDir:dir,downloadChunk:async(_id,index)=>{secondRun.push(index);return last},complete:async value=>{results.push(value)}});
    assert.deepEqual(secondRun,[1],'the already verified first chunk is not downloaded again');
    assert.deepEqual(fs.readFileSync(saved.path),all);
    assert.equal(results.at(-1).status,'completed');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a lost completion acknowledgement does not create a duplicate file on retry',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-ack-'));
  const bytes=Buffer.from('saved once'),transfer=makeTransfer(bytes,'one.mov');
  let downloads=0,completions=0;
  try{
    await assert.rejects(receiveTransfer({transfer,baseDir:dir,downloadChunk:async()=>{downloads++;return bytes},complete:async()=>{completions++;throw new Error('connection lost after save')}}),/connection lost/);
    assert.equal(fs.readFileSync(path.join(dir,'one.mov')).toString(),bytes.toString());
    const saved=await receiveTransfer({transfer,baseDir:dir,downloadChunk:async()=>{downloads++;return bytes},complete:async value=>{completions++;assert.equal(value.status,'completed')}});
    assert.equal(saved.path,path.join(dir,'one.mov'));
    assert.equal(downloads,1,'retry verifies the already-saved file instead of downloading it again');
    assert.equal(completions,2);
    assert.deepEqual(fs.readdirSync(dir),['one.mov']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a second file with the same name never overwrites the first file',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-collision-'));
  const first=Buffer.from('first'),second=Buffer.from('second');
  const a=makeTransfer(first,'same.mov','6a2f1c1a-6b8e-4b9d-8a32-91ac6d90d771');
  const b=makeTransfer(second,'same.mov','6a2f1c1a-6b8e-4b9d-8a32-91ac6d90d772');
  try{
    const one=await receiveTransfer({transfer:a,baseDir:dir,downloadChunk:async()=>first,complete:async()=>{}});
    const two=await receiveTransfer({transfer:b,baseDir:dir,downloadChunk:async()=>second,complete:async()=>{}});
    assert.equal(path.basename(one.path),'same.mov');
    assert.equal(path.basename(two.path),'same (6a2f1c1a).mov');
    assert.equal(fs.readFileSync(one.path).toString(),'first');
    assert.equal(fs.readFileSync(two.path).toString(),'second');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('corrupt chunks are rejected, partial files are removed, and failure is reported',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-bad-'));
  const bytes=Buffer.from('original bytes'),wrong=Buffer.from('tampered bytes'),transfer=makeTransfer(bytes,'bad.bin');
  let result;
  try{
    await assert.rejects(receiveTransfer({transfer,baseDir:dir,downloadChunk:async()=>wrong,complete:async value=>{result=value}}),/integrity check/);
    assert.equal(result.status,'failed');
    assert.deepEqual(fs.readdirSync(dir),[]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('receiver enforces the 2 GB transfer ceiling and fixed 8 MB chunk size',()=>{
  assert.equal(CHUNK_SIZE,8*1024*1024);
  assert.equal(MAX_FILE_SIZE,2*1024*1024*1024);
  assert.equal(safeName(''),'file');
});

test('invalid transfer metadata and missing cloud chunks fail clearly instead of retrying forever',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-invalid-'));
  const bytes=Buffer.from('metadata check'),transfer=makeTransfer(bytes,'invalid.bin');
  let result;
  try{
    const invalid={...transfer,chunks:[{...transfer.chunks[0],sha256:'bad'}]};
    await assert.rejects(receiveTransfer({transfer:invalid,baseDir:dir,downloadChunk:async()=>bytes,complete:async value=>{result=value}}),/metadata/);
    assert.equal(result.status,'failed');
    result=null;
    await assert.rejects(receiveTransfer({transfer,baseDir:dir,downloadChunk:async()=>{throw Object.assign(new Error('chunk missing'),{statusCode:404})},complete:async value=>{result=value}}),/chunk missing/);
    assert.equal(result.status,'failed');
    assert.deepEqual(fs.readdirSync(dir),[]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
