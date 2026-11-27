'use strict';
const {spawn}=require('node:child_process');

function startSystemAudioLoopback({naudioDll,scriptPath,source,onError=()=>{}}={}){
 if(process.platform!=='win32')throw new Error('System audio loopback is only available on Windows connectors.');
 if(!naudioDll||!scriptPath)throw new Error('Windows system-audio capture runtime is not installed.');
 const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptPath,'-NaudioDll',naudioDll],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stderr='',buffer=Buffer.alloc(0),format=null,closed=false,lastDataAt=Date.now();
 const fail=message=>{if(!closed)onError(message instanceof Error?message:new Error(String(message)))};
 function consume(){
  if(!format)return;
  const bytesPerSample=format.bitsPerSample/8;
  const framesPerPacket=format.sampleRate/100;
  if(!Number.isInteger(framesPerPacket)||!Number.isInteger(bytesPerSample)||!['IeeeFloat','Pcm'].includes(format.encoding))throw new Error('Unsupported Windows loopback audio format: '+JSON.stringify(format));
  const packetBytes=framesPerPacket*format.channels*bytesPerSample;
  while(buffer.length>=packetBytes){
   const packet=buffer.subarray(0,packetBytes);buffer=buffer.subarray(packetBytes);
   const samples=new Int16Array(framesPerPacket*format.channels);
   if(format.encoding==='IeeeFloat'&&format.bitsPerSample===32){for(let i=0;i<samples.length;i++){const value=packet.readFloatLE(i*4);samples[i]=Math.max(-32768,Math.min(32767,Math.round((Number.isFinite(value)?value:0)*32767)))}}
   else if(format.encoding==='Pcm'&&format.bitsPerSample===16){for(let i=0;i<samples.length;i++)samples[i]=packet.readInt16LE(i*2)}
   else throw new Error('Unsupported Windows loopback PCM encoding: '+format.encoding+'/'+format.bitsPerSample);
   source.onData({samples,sampleRate:format.sampleRate,bitsPerSample:16,channelCount:format.channels,numberOfFrames:framesPerPacket});
   lastDataAt=Date.now();
  }
 }
 child.stdout.on('data',chunk=>{if(closed)return;buffer=buffer.length?Buffer.concat([buffer,chunk]):chunk;try{consume()}catch(error){fail(error);stop()}});
 child.stderr.on('data',chunk=>{
  stderr+=chunk.toString('utf8');
  const lines=stderr.split(/\r?\n/);stderr=lines.pop()||'';
  for(const line of lines){
   const match=line.match(/PB_AUDIO_FORMAT:(\d+):(\d+):(\d+):([A-Za-z0-9]+)/);
   if(match){format={sampleRate:Number(match[1]),channels:Number(match[2]),bitsPerSample:Number(match[3]),encoding:match[4]};try{consume()}catch(error){fail(error);stop()}continue}
   if(line.startsWith('PB_AUDIO_ERROR:'))fail(line.slice(15));
   else if(line.trim())fail(new Error('Windows system-audio capture: '+line.trim().slice(0,240)));
  }
 });
 child.once('error',error=>{fail(error);stop()});
 child.once('close',code=>{if(!closed&&code!==0)fail(new Error('Windows system-audio capture exited with code '+code));stop()});
 const watchdog=setInterval(()=>{if(!closed&&Date.now()-lastDataAt>8000){fail(new Error('Windows system-audio capture stopped delivering audio frames.'));stop()}},2000);watchdog.unref?.();
 function stop(){if(closed)return;closed=true;clearInterval(watchdog);buffer=Buffer.alloc(0);try{child.kill()}catch{}}
 return {stop,child};
}
module.exports={startSystemAudioLoopback};
