'use strict';

const { execFileSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');

function captureScreenJpeg() {
  if(process.platform!=='win32')throw new Error('Live desktop capture currently requires the Windows connector.');
  if(!ffmpegPath)throw new Error('FFmpeg screen capture is not installed with this PhoneBridge connector.');
  const frame=execFileSync(ffmpegPath,[
    '-hide_banner','-loglevel','error','-f','gdigrab','-framerate','1','-i','desktop',
    '-frames:v','1','-vf','scale=1280:720:force_original_aspect_ratio=decrease',
    '-q:v','7','-f','image2pipe','-vcodec','mjpeg','pipe:1'
  ],{encoding:'buffer',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:6000,maxBuffer:5*1024*1024});
  if(!frame||frame.length<100||frame.length>780000||frame[0]!==255||frame[1]!==216)
    throw new Error('FFmpeg did not return a valid desktop JPEG frame. Check that the Windows connector is running in the signed-in desktop session.');
  return frame;
}

module.exports={captureScreenJpeg};