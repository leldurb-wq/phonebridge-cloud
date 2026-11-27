'use strict';

const { execFileSync, spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');

function captureScreenJpeg() {
  if(process.platform!=='win32')throw new Error('Live desktop capture currently requires the Windows connector.');
  if(!ffmpegPath)throw new Error('FFmpeg screen capture is not installed with this PhoneBridge connector.');
  const frame=execFileSync(ffmpegPath,[
    '-hide_banner','-loglevel','error','-f','gdigrab','-framerate','1','-i','desktop',
    '-frames:v','1','-vf','scale=1024:576:force_original_aspect_ratio=decrease:flags=fast_bilinear',
    '-q:v','10','-f','image2pipe','-vcodec','mjpeg','pipe:1'
  ],{encoding:'buffer',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:6000,maxBuffer:5*1024*1024});
  if(!frame||frame.length<100||frame.length>780000||frame[0]!==255||frame[1]!==216)
    throw new Error('FFmpeg did not return a valid desktop JPEG frame. Check that the Windows connector is running in the signed-in desktop session.');
  return frame;
}

/*
 * Keep one FFmpeg capture process alive instead of starting a new process for
 * every screenshot. This lowers startup latency and provides a steady MJPEG feed.
 */
function startScreenCaptureStream({onFrame,onError,frameRate=8}={}) {
  if(process.platform!=='win32')throw new Error('Live desktop capture currently requires the Windows connector.');
  if(!ffmpegPath)throw new Error('FFmpeg screen capture is not installed with this PhoneBridge connector.');
  let child=null,stopped=false,restartTimer=null,buffer=Buffer.alloc(0),stderr='';
  const fps=Math.max(1,Math.min(10,Math.floor(Number(frameRate)||10)));
  function report(error){try{onError?.(error)}catch{}}
  function start(){
    if(stopped)return;
    buffer=Buffer.alloc(0);stderr='';
    child=spawn(ffmpegPath,[
      '-hide_banner','-loglevel','error','-fflags','nobuffer','-flags','low_delay',
      '-thread_queue_size','64','-f','gdigrab','-framerate',String(fps),'-draw_mouse','1','-i','desktop',
      '-vf','scale=1024:576:force_original_aspect_ratio=decrease:flags=fast_bilinear',
      '-q:v','10','-f','image2pipe','-vcodec','mjpeg','pipe:1'
    ],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(true){
        const startAt=buffer.indexOf(Buffer.from([0xff,0xd8]));
        if(startAt<0){buffer=buffer.length?buffer.subarray(buffer.length-1):buffer;break}
        if(startAt>0)buffer=buffer.subarray(startAt);
        const endAt=buffer.indexOf(Buffer.from([0xff,0xd9]),2);
        if(endAt<0)break;
        const frame=Buffer.from(buffer.subarray(0,endAt+2));
        buffer=buffer.subarray(endAt+2);
        if(frame.length>=100&&frame.length<=780000){try{onFrame?.(frame)}catch(error){report(error)}}
      }
      if(buffer.length>900000){
        const lastStart=buffer.lastIndexOf(Buffer.from([0xff,0xd8]));
        buffer=lastStart>=0?buffer.subarray(lastStart):Buffer.alloc(0);
      }
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-2000)});
    child.once('error',error=>{report(error)});
    child.once('close',code=>{
      child=null;
      if(stopped)return;
      if(code!==0)report(new Error('Desktop capture process stopped ('+code+'). '+stderr.trim().slice(-500)));
      restartTimer=setTimeout(start,1500);
    });
  }
  start();
  return {
    stop(){
      stopped=true;
      if(restartTimer)clearTimeout(restartTimer);
      restartTimer=null;
      if(child){const current=child;child=null;try{current.kill()}catch{}}
      buffer=Buffer.alloc(0);
    }
  };
}

module.exports={captureScreenJpeg,startScreenCaptureStream};