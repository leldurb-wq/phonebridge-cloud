'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {receiveTransfer,CHUNK_SIZE,MAX_FILE_SIZE,safeName}=require('../agent/file-transfer');

test('PhoneBridge transfer names cannot escape the designated incoming folder',()=>{
  assert.equal(safeName('../../secret.txt'),'_.._secret.txt');
  assert.equal(safeName('C:\\Users\\Other\\file?.txt'),'C__Users_Other_file_.txt');
  assert.equal(safeName('...'),'file');
});

test('large-file receiver writes verified chunks atomically and reports completion',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-'));
  const bytes=Buffer.from('PhoneBridge chunk test');
  const transferId='6a2f1c1a-6b8e-4b9d-8a32-91ac6d90d777';
  const transfer={id:transferId,fileName:'movie.bin',sizeBytes:bytes.length,chunkSize:CHUNK_SIZE,chunkCount:1,chunks:[{index:0,sizeBytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]};
  let result,attempts=0;
  try{
    const saved=await receiveTransfer({transfer,baseDir:dir,downloadChunk:async()=>{attempts++;if(attempts===1)throw Error('temporary network interruption');return bytes},complete:async value=>{result=value}});
    assert.equal(fs.readFileSync(saved.path).toString(),bytes.toString());
    assert.equal(saved.size,bytes.length);
    assert.equal(attempts,2,'a transient network error is retried once before succeeding');
    assert.deepEqual(result,{status:'completed'});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('receiver resumes from the last complete verified chunk after a worker restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-resume-'));
  const first=Buffer.alloc(CHUNK_SIZE,0x61),last=Buffer.from('tail'),all=Buffer.concat([first,last]);
  const transferId='6a2f1c1a-6b8e-4b9d-8a32-91ac6d90d777';
  const transfer={id:transferId,fileName:'resume.bin',sizeBytes:all.length,chunkSize:CHUNK_SIZE,chunkCount:2,chunks:[
    {index:0,sizeBytes:first.length,sha256:crypto.createHash('sha256').update(first).digest('hex')},
    {index:1,sizeBytes:last.length,sha256:crypto.createHash('sha256').update(last).digest('hex')}
  ]};
  const partial=path.join(dir,'resume.bin.'+transferId+'.part');
  fs.writeFileSync(partial,first);
  const requested=[];
  try{
    const saved=await receiveTransfer({transfer,baseDir:dir,downloadChunk:async(_id,index)=>{requested.push(index);return last},complete:async()=>{}});
    assert.deepEqual(requested,[1]);
    assert.deepEqual(fs.readFileSync(saved.path),all);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('corrupt chunks are rejected, partial files are removed, and failure is reported',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-transfer-bad-'));
  const bytes=Buffer.from('original bytes'),wrong=Buffer.from('tampered bytes');
  const transfer={id:'6a2f1c1a-6b8e-4b9d-8a32-91ac6d90d777',fileName:'bad.bin',sizeBytes:bytes.length,chunkSize:CHUNK_SIZE,chunkCount:1,chunks:[{index:0,sizeBytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]};
  let result;
  try{
    await assert.rejects(receiveTransfer({transfer,baseDir:dir,downloadChunk:async()=>wrong,complete:async value=>{result=value}}),/integrity check/);
    assert.deepEqual(result.status,'failed');
    assert.deepEqual(fs.readdirSync(dir),[]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('receiver enforces the 2 GB transfer ceiling and fixed 8 MB chunk size',()=>{
  assert.equal(CHUNK_SIZE,8*1024*1024);
  assert.equal(MAX_FILE_SIZE,2*1024*1024*1024);
  assert.equal(safeName(''),'file');
});
