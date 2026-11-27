'use strict';
const {spawn}=require('node:child_process');
const {RTCPeerConnection,RTCSessionDescription,MediaStream,nonstandard}=require('@roamhq/wrtc');
const {RTCVideoSource,RTCAudioSource}=nonstandard;
const {startSystemAudioLoopback}=require('./audio-loopback');
function waitIce(pc,timeout=12000){if(pc.iceGatheringState==='complete')return Promise.resolve();return new Promise(resolve=>{const timer=setTimeout(done,timeout);function done(){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);resolve()}function check(){if(pc.iceGatheringState==='complete')done()}pc.addEventListener('icegatheringstatechange',check)})}
async function answerScreenOffer({offer,ffmpegPath,frameRate=20,width=1280,height=720,naudioDll=process.env.PHONEBRIDGE_NAUDIO_DLL,audioScriptPath=process.env.PHONEBRIDGE_AUDIO_LOOPBACK_SCRIPT,onError=()=>{}}){
 if(!offer||offer.type!=='offer'||typeof offer.sdp!=='string')throw new Error('Invalid WebRTC screen offer.');
 const fps=Math.max(20,Math.min(30,Math.floor(Number(frameRate)||20)));
 const pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]});
 const videoSource=new RTCVideoSource({isScreencast:true,needsDenoising:false});
 const videoTrack=videoSource.createTrack();
 const audioSource=new RTCAudioSource();
 const audioTrack=audioSource.createTrack();
 const stream=new MediaStream([videoTrack,audioTrack]);
 pc.addTrack(videoTrack,stream);pc.addTrack(audioTrack,stream);
 let videoChild=null,audioCapture=null,audioRetryTimer=null,audioRetryDelay=1000,buffer=Buffer.alloc(0),closed=false,lastFrameAt=Date.now();
 let captureRestartTimer=null,captureRestartDelay=500,watchdog=null;
 const frameBytes=width*height*3/2;
 const close=()=>{if(closed)return;closed=true;if(watchdog)clearInterval(watchdog);watchdog=null;if(captureRestartTimer)clearTimeout(captureRestartTimer);captureRestartTimer=null;if(audioRetryTimer)clearTimeout(audioRetryTimer);audioRetryTimer=null;const child=videoChild;videoChild=null;if(child){try{child.kill()}catch{}}if(audioCapture){try{audioCapture.stop()}catch{}audioCapture=null}try{videoTrack.stop()}catch{}try{audioTrack.stop()}catch{}try{pc.close()}catch{}buffer=Buffer.alloc(0)};
 function scheduleAudioRestart(error){if(closed)return;onError(error);if(audioRetryTimer)return;if(audioCapture){try{audioCapture.stop()}catch{}audioCapture=null}const delay=audioRetryDelay;audioRetryDelay=Math.min(audioRetryDelay*2,15000);audioRetryTimer=setTimeout(()=>{audioRetryTimer=null;startAudioCapture()},delay);audioRetryTimer.unref?.()}
 function startAudioCapture(){if(closed)return;try{audioCapture=startSystemAudioLoopback({naudioDll,scriptPath:audioScriptPath,source:audioSource,onError:error=>scheduleAudioRestart(new Error('System audio: '+error.message))})}catch(error){scheduleAudioRestart(new Error('System audio unavailable: '+error.message))}}
 pc.addEventListener('connectionstatechange',()=>{if(['failed','closed'].includes(pc.connectionState))close()});
 try{
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer=await pc.createAnswer();await pc.setLocalDescription(answer);await waitIce(pc);
  if(!pc.localDescription?.sdp)throw new Error('WebRTC did not produce a local answer.');
  function scheduleVideoRestart(reason){if(closed||captureRestartTimer)return;if(reason)onError(reason instanceof Error?reason:new Error(String(reason)));const child=videoChild;videoChild=null;buffer=Buffer.alloc(0);if(child){try{child.kill()}catch{}}const delay=captureRestartDelay;captureRestartDelay=Math.min(captureRestartDelay*2,8000);captureRestartTimer=setTimeout(()=>{captureRestartTimer=null;startVideoCapture()},delay);captureRestartTimer.unref?.()}
  function startVideoCapture(){if(closed||videoChild)return;buffer=Buffer.alloc(0);let child;try{child=spawn(ffmpegPath,['-hide_banner','-loglevel','error','-fflags','nobuffer','-flags','low_delay','-thread_queue_size','64','-f','gdigrab','-framerate',String(fps),'-draw_mouse','1','-i','desktop','-an','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,'-pix_fmt','yuv420p','-f','rawvideo','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});videoChild=child}catch(error){scheduleVideoRestart(new Error('Unable to start desktop capture: '+error.message));return}
   child.stdout.on('data',chunk=>{if(closed||videoChild!==child)return;buffer=buffer.length?Buffer.concat([buffer,chunk]):chunk;const complete=Math.floor(buffer.length/frameBytes);if(!complete)return;const frame=buffer.subarray((complete-1)*frameBytes,complete*frameBytes);buffer=buffer.subarray(complete*frameBytes);try{const exactFrame=new Uint8Array(frameBytes);exactFrame.set(frame);videoSource.onFrame({width,height,data:exactFrame});lastFrameAt=Date.now();captureRestartDelay=500}catch(error){scheduleVideoRestart(new Error('Desktop frame delivery failed: '+error.message))}});
   child.stderr.on('data',chunk=>{if(videoChild!==child)return;const message=chunk.toString('utf8').trim();if(message)onError(new Error(message.slice(0,300))) });
   child.once('error',error=>{if(videoChild===child)scheduleVideoRestart(new Error('Desktop capture process error: '+error.message))});child.once('close',code=>{if(videoChild===child)scheduleVideoRestart(new Error('Desktop capture exited'+(code===null?'':' with code '+code)+'; restoring stream'))});
  }
  startVideoCapture();
  watchdog=setInterval(()=>{if(!closed&&!captureRestartTimer&&Date.now()-lastFrameAt>5000)scheduleVideoRestart(new Error('Desktop capture stalled; restarting capture without disconnecting WebRTC.'))},1500);watchdog.unref?.();
  startAudioCapture();
  return {answer:pc.localDescription,close,pc,audioEnabled:true};
 }catch(error){close();throw error}
}
module.exports={answerScreenOffer};