param([Parameter(Mandatory=$true)][string]$NaudioDll)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $NaudioDll)) { [Console]::Error.WriteLine('PhoneBridge audio: NAudio runtime is missing.'); exit 2 }
Add-Type -Path $NaudioDll
$source = @'
using System;
using System.IO;
using System.Threading;
using NAudio.Wave;
public static class PhoneBridgeAudioLoopback {
  public static void Run() {
    Stream output = Console.OpenStandardOutput();
    using (var capture = new WasapiLoopbackCapture()) {
      var format = capture.WaveFormat;
      Console.Error.WriteLine("PB_AUDIO_FORMAT:" + format.SampleRate + ":" + format.Channels + ":" + format.BitsPerSample + ":" + format.Encoding);
      capture.DataAvailable += (sender, args) => {
        try { lock (output) { output.Write(args.Buffer, 0, args.BytesRecorded); output.Flush(); } }
        catch (IOException) { }
      };
      capture.RecordingStopped += (sender, args) => {
        if (args.Exception != null) Console.Error.WriteLine("PB_AUDIO_ERROR:" + args.Exception.Message);
      };
      capture.StartRecording();
      while (true) Thread.Sleep(1000);
    }
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll', $NaudioDll) -ErrorAction Stop
[PhoneBridgeAudioLoopback]::Run()
